// SPDX-License-Identifier: Apache-2.0

/**
 * The run's call journal on the sidecar side: every upstream call the sidecar dispatches for an
 * integration is queued here and POSTed in batches to `/internal/integration-calls` with the run
 * token; the platform derives org, space, actor and owner from the run. Best-effort: a refused or
 * failed POST is logged and its records dropped, never retried nor thrown into the call path.
 */

import { requiredScopesFromChallenge } from "@appstrate/core/www-authenticate";
import type { IntegrationCredentialsSource } from "./integration-credentials-source.ts";
import { logger } from "./logger.ts";

/** One upstream call, on the wire of `POST /internal/integration-calls` (snake_case). */
export interface IntegrationCallRecord {
  integration_id: string;
  /** NULL for an integration that binds no connection (unauthenticated, AFPS §7.2). */
  connection_id: string | null;
  method: string;
  /** Never a credential value (`{{field}}` in its place); NULL for a local MCP operation. */
  host: string | null;
  /** The upstream's HTTP status as a string, or the sidecar's failure code after dispatch. */
  outcome: string;
  duration_ms: number;
  /** Set only on a record that ends the connection's rejection streak. */
  credential_revision?: string;
  /** Set only on a 403 `insufficient_scope` through a connection: the scopes the challenge named. */
  required_scopes?: string[];
}

export interface CallReporter {
  /** `onUndelivered` runs when the POST carrying the record does not answer 2xx. */
  report(record: IntegrationCallRecord, onUndelivered?: () => void): void;
  /** Sends what is queued and resolves once every POST in flight has settled. */
  drain(): Promise<void>;
}

/** The platform's cap of records per batch. */
const DEFAULT_MAX_BATCH = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
/** Most batches held, queued or awaiting their turn: at most 5 POSTs per 2 s, under the route's 200/min. */
const QUEUED_BATCHES = 5;
/** Under the orchestrators' SIGTERM grace (5 s), so a shutdown drain cannot be cut short. */
const POST_TIMEOUT_MS = 3_000;

export function createCallReporter(opts: {
  platformApiUrl: string;
  runToken: string;
  fetchFn?: typeof fetch;
  flushIntervalMs?: number;
  maxBatch?: number;
}): CallReporter {
  const fetchFn = opts.fetchFn ?? fetch;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const url = `${opts.platformApiUrl.replace(/\/$/, "")}/internal/integration-calls`;
  let queue: { record: IntegrationCallRecord; onUndelivered?: () => void }[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One POST at a time, in queue order: the journal's ids follow the calls.
  const batches: (typeof queue)[] = [];
  let sending: Promise<void> | undefined;
  const held = () => queue.length + batches.reduce((sum, batch) => sum + batch.length, 0);

  const post = async (entries: typeof queue): Promise<void> => {
    const calls = entries.map((entry) => entry.record);
    const undelivered = () => {
      for (const entry of entries) entry.onUndelivered?.();
    };
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.runToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ calls }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn("integration call report refused, records dropped", {
          status: res.status,
          records: calls.length,
        });
        undelivered();
      }
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      logger.warn("integration call report failed, records dropped", {
        records: calls.length,
        error: err instanceof Error ? err.message : String(err),
      });
      undelivered();
    }
  };

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (dropped > 0) {
      logger.warn("integration call journal full, records dropped", { records: dropped });
      dropped = 0;
    }
    for (let i = 0; i < queue.length; i += maxBatch) batches.push(queue.slice(i, i + maxBatch));
    queue = [];
    sending ??= (async () => {
      for (let batch = batches.shift(); batch; batch = batches.shift()) await post(batch);
      sending = undefined;
    })();
  };

  return {
    report(record, onUndelivered) {
      // A streak-ending record goes at once: the connection is shown as failing until it lands.
      if (record.credential_revision !== undefined) {
        queue.push({ record, ...(onUndelivered ? { onUndelivered } : {}) });
        flush();
        return;
      }
      if (held() >= maxBatch * QUEUED_BATCHES) {
        dropped++;
        return;
      }
      queue.push({ record, ...(onUndelivered ? { onUndelivered } : {}) });
      if (timer === undefined) {
        timer = setTimeout(flush, flushIntervalMs);
        timer.unref?.();
      }
    },
    async drain() {
      flush();
      await sending;
    },
  };
}

/** One dispatched call, as a call site sees it. */
export interface DispatchedCall {
  method: string;
  /** NULL for an operation of a local MCP server: its upstream requests are not seen. */
  host: string | null;
  outcome: string;
  durationMs: number;
  /** The injected credential the final response answered, `null` when it answered none. */
  credential: { revision: string | undefined } | null;
  /** The response's `WWW-Authenticate` header, when it answered with one. */
  challenge?: string | null;
}

export type CallJournal = (call: DispatchedCall) => void;

const SUCCESS_OUTCOME = /^2\d\d$/;

/**
 * The journal of one integration's calls through one bound connection (or none). A 2xx answered
 * with the injected credential carries the revision when it ends a pending rejection streak
 * (`streakEndingRevision`), and re-arms it when that record does not land (`streakNotEnded`). A 403
 * `insufficient_scope` answered on it carries the scopes the challenge named (`required_scopes`).
 */
export function connectionCallJournal(
  reporter: CallReporter,
  binding: {
    integrationId: string;
    connectionId: string | null;
    source: Pick<IntegrationCredentialsSource, "streakEndingRevision" | "streakNotEnded"> | null;
  },
): CallJournal {
  return (call) => {
    const revision =
      call.credential && binding.source && SUCCESS_OUTCOME.test(call.outcome)
        ? binding.source.streakEndingRevision(call.credential.revision)
        : undefined;
    const source = binding.source;
    // A 403 `insufficient_scope` on the injected credential names the connection's step-up demand.
    const requiredScopes =
      call.credential && binding.connectionId && call.outcome === "403"
        ? requiredScopesFromChallenge(403, call.challenge ?? null)
        : undefined;
    reporter.report(
      {
        integration_id: binding.integrationId,
        connection_id: binding.connectionId,
        method: call.method,
        host: call.host,
        outcome: call.outcome,
        duration_ms: Math.max(0, Math.round(call.durationMs)),
        ...(revision !== undefined ? { credential_revision: revision } : {}),
        ...(requiredScopes ? { required_scopes: requiredScopes } : {}),
      },
      revision !== undefined && source ? () => source.streakNotEnded(revision) : undefined,
    );
  };
}
