// SPDX-License-Identifier: Apache-2.0

/**
 * The run's call journal on the sidecar side: every upstream call the sidecar dispatches for an
 * integration is queued here and POSTed in batches to `/internal/integration-calls` with the run
 * token; the platform derives org, space, actor and owner from the run. Best-effort: a POST that
 * fails in transport or answers 5xx is retried once, at once (no backoff; each record carries its
 * `call_id`, so a batch the platform already took is stored once), then logged and its records
 * dropped, never thrown into the call path. A drain ends by a deadline
 * ({@link CALL_JOURNAL_DRAIN_DEADLINE_MS}), whatever the platform does.
 */

import { CALL_JOURNAL_DRAIN_DEADLINE_MS } from "@appstrate/core/sidecar-types";
import type { IntegrationCredentialsSource } from "./integration-credentials-source.ts";
import { logger } from "./logger.ts";

/** One upstream call, on the wire of `POST /internal/integration-calls` (snake_case). */
export interface IntegrationCallRecord {
  /** The call's identity (UUIDv7), minted here: with the run, the key that deduplicates a retried POST. */
  call_id: string;
  /** When the upstream call started (RFC 3339). */
  called_at: string;
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
}

export interface CallReporter {
  /** `onUndelivered` runs when the POST carrying the record does not answer 2xx. */
  report(record: IntegrationCallRecord, onUndelivered?: () => void): void;
  /**
   * Sends what is queued and resolves once every POST in flight has settled, or at the deadline.
   * Drains that overlap share the one running deadline.
   */
  drain(): Promise<void>;
}

/** The platform's cap of records per batch. */
const DEFAULT_MAX_BATCH = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
/** Most batches held, queued or awaiting their turn: the overflow is dropped at `report`. */
const QUEUED_BATCHES = 5;
/** One POST attempt; the deadline of a drain already running when the attempt starts bounds it too. */
const POST_TIMEOUT_MS = 3_000;

export function createCallReporter(opts: {
  platformApiUrl: string;
  runToken: string;
  fetchFn?: typeof fetch;
  flushIntervalMs?: number;
  maxBatch?: number;
  /** Overrides {@link CALL_JOURNAL_DRAIN_DEADLINE_MS}; tests only, to avoid waiting it out. */
  drainDeadlineMs?: number;
}): CallReporter {
  const fetchFn = opts.fetchFn ?? fetch;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const drainDeadlineMs = opts.drainDeadlineMs ?? CALL_JOURNAL_DRAIN_DEADLINE_MS;
  const url = `${opts.platformApiUrl.replace(/\/$/, "")}/internal/integration-calls`;
  let queue: { record: IntegrationCallRecord; onUndelivered?: () => void }[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One POST at a time, in queue order: the journal's ids follow the calls.
  const batches: (typeof queue)[] = [];
  let sending: Promise<void> | undefined;
  // The running drain's deadline: it also bounds every POST attempt made while it runs.
  let drainDeadline: AbortSignal | undefined;
  // Overlapping drains (the agent's flush, then SIGTERM) share one run, hence one deadline.
  let draining: Promise<void> | undefined;
  const held = () => queue.length + batches.reduce((sum, batch) => sum + batch.length, 0);

  const undeliver = (entries: typeof queue) => {
    for (const entry of entries) entry.onUndelivered?.();
  };

  const post = async (entries: typeof queue): Promise<void> => {
    const calls = entries.map((entry) => entry.record);
    // A second attempt only for a transport failure or a 5xx: the platform may have taken the first
    // (`call_id` makes that harmless), and a 4xx would be refused again.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const deadline = drainDeadline;
      const signal = deadline
        ? AbortSignal.any([AbortSignal.timeout(POST_TIMEOUT_MS), deadline])
        : AbortSignal.timeout(POST_TIMEOUT_MS);
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.runToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ calls }),
          signal,
        });
        await res.body?.cancel().catch(() => {});
        if (res.ok) return;
        if (res.status < 500 || attempt === 2 || deadline?.aborted) {
          logger.warn("integration call report refused, records dropped", {
            status: res.status,
            records: calls.length,
          });
          undeliver(entries);
          return;
        }
      } catch (err) {
        if (attempt === 2 || deadline?.aborted) {
          logger.warn("integration call report failed, records dropped", {
            records: calls.length,
            error: err instanceof Error ? err.message : String(err),
          });
          undeliver(entries);
          return;
        }
      }
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
    // Nothing to send: a sender that finished at once would clear `sending` before it is assigned.
    if (sending || batches.length === 0) return;
    sending = (async () => {
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
    drain() {
      if (draining) {
        flush();
        return draining;
      }
      const run = async () => {
        const deadline = AbortSignal.timeout(drainDeadlineMs);
        drainDeadline = deadline;
        flush();
        const settled = sending;
        if (settled) {
          await new Promise<void>((resolve) => {
            deadline.addEventListener("abort", () => resolve(), { once: true });
            void settled.then(() => resolve());
          });
        }
        drainDeadline = undefined;
        if (!deadline.aborted) return;
        // Out of time: what no POST has taken yet is dropped, and counted.
        const unsent = batches.splice(0);
        let lost = 0;
        for (const batch of unsent) {
          lost += batch.length;
          undeliver(batch);
        }
        if (lost === 0) return;
        logger.warn("integration call journal drain hit its deadline, records dropped", {
          records: lost,
          deadline_ms: drainDeadlineMs,
        });
      };
      draining = run().finally(() => {
        draining = undefined;
      });
      return draining;
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
  /** Epoch ms read where the duration starts: the call's start, whenever it is journaled. */
  startedAtMs: number;
  /** The injected credential the final response answered, `null` when it answered none. */
  credential: { revision: string | undefined } | null;
}

export type CallJournal = (call: DispatchedCall) => void;

const SUCCESS_OUTCOME = /^2\d\d$/;

/**
 * The journal of one integration's calls through one bound connection (or none). A 2xx answered
 * with the injected credential carries the revision when it ends a pending rejection streak
 * (`streakEndingRevision`), and re-arms it when that record does not land (`streakNotEnded`).
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
    const durationMs = Math.max(0, Math.round(call.durationMs));
    const revision =
      call.credential && binding.source && SUCCESS_OUTCOME.test(call.outcome)
        ? binding.source.streakEndingRevision(call.credential.revision)
        : undefined;
    const source = binding.source;
    reporter.report(
      {
        call_id: Bun.randomUUIDv7(),
        called_at: new Date(call.startedAtMs).toISOString(),
        integration_id: binding.integrationId,
        connection_id: binding.connectionId,
        method: call.method,
        host: call.host,
        outcome: call.outcome,
        duration_ms: durationMs,
        ...(revision !== undefined ? { credential_revision: revision } : {}),
      },
      revision !== undefined && source ? () => source.streakNotEnded(revision) : undefined,
    );
  };
}
