// SPDX-License-Identifier: Apache-2.0

/**
 * Single writer of the append-only `llm_usage` ledger.
 *
 * Every producer — the inference proxy (`llm-proxy/metering.ts`), the agent
 * runner sink (`run-launcher/appstrate-event-sink.ts`) and the subscription
 * chat engine seam (`chat-subscription.ts`) — inserts through {@link
 * recordLlmUsage} instead of building its own `db.insert(llmUsage)`. Two things
 * are unified here so they can't drift:
 *
 *   1. the column mapping + the ledger check-constraint invariants (a proxy row
 *      carries a `request_id`; a row is attributed to at most one context);
 *   2. the broadcast of the `onUsageRecorded` module event — fired inline the
 *      instant the row is durably written, EXCEPT when a caller records inside
 *      its own transaction: it passes {@link RecordLlmUsageOptions.deferEmit}
 *      and the built event is handed back to that collector so the caller can
 *      broadcast it AFTER commit (via {@link emitUsageRecorded}). This keeps a
 *      row whose transaction later rolls back from firing a phantom event.
 *
 * It is intentionally a thin insert+emit seam, not a framework: cost is already
 * computed by each caller (they own the token→USD arithmetic and their own
 * best-effort try/catch), and the runner's monotonic upsert is expressed as one
 * opt-in flag rather than a second code path.
 */

import { db, type Db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { sql } from "drizzle-orm";
import type { UsageRecordedParams } from "@appstrate/core/module";
import { emitEvent } from "../lib/modules/module-loader.ts";

/** Credential set that reached the upstream provider for a ledger row. */
export type CredentialSource = "system" | "org";

/**
 * One `llm_usage` row to append. Covers every producer's needs; unset optional
 * fields insert as NULL / their column default. The caller supplies the already
 * computed {@link costUsd} — this service performs no pricing arithmetic.
 */
export interface LlmUsageEntry {
  source: "proxy" | "runner";
  orgId: string;
  /** Set for a JWT-authenticated user principal. */
  userId?: string | null;
  /** Set for an API-key principal. */
  apiKeyId?: string | null;
  /** Run attribution — mutually exclusive with {@link chatSessionId}. */
  runId?: string | null;
  /** Chat-session attribution — mutually exclusive with {@link runId}. */
  chatSessionId?: string | null;
  /** Preset id (org model row id) the caller selected — stored as `llm_usage.model`. */
  model?: string | null;
  /** Real upstream model id — SERVER-SIDE ONLY, never exposed to modules. */
  realModel?: string | null;
  /** Protocol family (`anthropic-messages`, …) — SERVER-SIDE ONLY. */
  api?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd: number;
  durationMs?: number | null;
  /** Proxy dedup key — required on proxy rows, null on runner rows. */
  requestId?: string | null;
  /** Which credential set reached the provider. */
  credentialSource?: CredentialSource | null;
}

export interface RecordLlmUsageOptions {
  /** Executor to insert with — pass a transaction on the runner ingestion path. */
  executor?: Db;
  /**
   * When set, INSERT with the runner's monotonic upsert against the partial
   * unique index `uq_llm_usage_runner_run_id` (at most one runner row per run;
   * the highest cumulative cost wins). The plain insert (proxy / chat) omits it.
   */
  onConflict?: "runner-monotonic";
  /**
   * Deferred-emit collector for a caller that records INSIDE its own
   * transaction. When provided, {@link recordLlmUsage} does NOT broadcast
   * `onUsageRecorded` inline — it hands the built event to this collector, and
   * the caller MUST broadcast it (via {@link emitUsageRecorded}) only AFTER its
   * transaction commits. This is what stops a rolled-back row from firing a
   * phantom event. It is called only when a row was actually written (a
   * monotonic-upsert no-op collects nothing). Non-transactional callers omit it
   * and the event fires inline as soon as the row is durable.
   */
  deferEmit?: (event: UsageRecordedParams) => void;
}

/** Derive the module-facing `(contextType, contextId)` from a row's attribution. */
function resolveContext(
  entry: LlmUsageEntry,
): Pick<UsageRecordedParams, "contextType" | "contextId"> {
  if (entry.runId) return { contextType: "run", contextId: entry.runId };
  if (entry.chatSessionId) return { contextType: "chat", contextId: entry.chatSessionId };
  return { contextType: null, contextId: null };
}

/**
 * Append one row to `llm_usage` and broadcast `onUsageRecorded`.
 *
 * Returns the new row's serial `id`, or `null` when a runner-monotonic upsert
 * was a no-op (an equal-or-lower cumulative total lost the conflict). The event
 * fires only when a row was actually written, and never for the server-side-only
 * columns (`real_model` / `api`). When {@link RecordLlmUsageOptions.deferEmit}
 * is supplied the event is collected instead of broadcast — see that option's
 * doc for the post-commit contract. DB errors are NOT swallowed here — each
 * caller owns its best-effort try/catch and its own log line.
 */
export async function recordLlmUsage(
  entry: LlmUsageEntry,
  opts: RecordLlmUsageOptions = {},
): Promise<number | null> {
  const executor = opts.executor ?? db;
  const values = {
    source: entry.source,
    orgId: entry.orgId,
    apiKeyId: entry.apiKeyId ?? null,
    userId: entry.userId ?? null,
    runId: entry.runId ?? null,
    chatSessionId: entry.chatSessionId ?? null,
    model: entry.model ?? null,
    realModel: entry.realModel ?? null,
    api: entry.api ?? null,
    credentialSource: entry.credentialSource ?? null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens ?? null,
    cacheWriteTokens: entry.cacheWriteTokens ?? null,
    costUsd: entry.costUsd,
    durationMs: entry.durationMs ?? null,
    requestId: entry.requestId ?? null,
  };

  const inserted =
    opts.onConflict === "runner-monotonic"
      ? await executor
          .insert(llmUsage)
          .values(values)
          // Two-level monotonic upsert on the partial unique index. Runner rows
          // are cumulative snapshots — tokens and cost grow together — so the row
          // must only ever advance:
          //   1. a strictly higher cumulative cost wins; else
          //   2. an EQUAL cost with a strictly higher total token count wins.
          // Level 2 is what keeps a zero-cost model (free model / no catalog rate
          // / zero-rate tokens) correct: its cost stays constant at 0 while token
          // counts keep climbing, so a cost-only rule would freeze the token
          // columns at their first values. Both levels use STRICT inequalities, so
          // an exact duplicate replay (same cost AND same tokens) is a no-op that
          // re-emits nothing — that idempotence is load-bearing for cursor
          // consumers. Out-of-order metric events and the finalize fallback can
          // never regress either dimension. Token columns are bumped alongside the
          // cost so the snapshot stays consistent.
          .onConflictDoUpdate({
            target: llmUsage.runId,
            targetWhere: sql`source = 'runner' AND run_id IS NOT NULL`,
            set: {
              inputTokens: sql`EXCLUDED.input_tokens`,
              outputTokens: sql`EXCLUDED.output_tokens`,
              cacheReadTokens: sql`EXCLUDED.cache_read_tokens`,
              cacheWriteTokens: sql`EXCLUDED.cache_write_tokens`,
              costUsd: sql`EXCLUDED.cost_usd`,
            },
            setWhere: sql`
              EXCLUDED.cost_usd > ${llmUsage.costUsd}
              OR (
                EXCLUDED.cost_usd = ${llmUsage.costUsd}
                AND EXCLUDED.input_tokens + EXCLUDED.output_tokens
                      + COALESCE(EXCLUDED.cache_read_tokens, 0)
                      + COALESCE(EXCLUDED.cache_write_tokens, 0)
                    > ${llmUsage.inputTokens} + ${llmUsage.outputTokens}
                      + COALESCE(${llmUsage.cacheReadTokens}, 0)
                      + COALESCE(${llmUsage.cacheWriteTokens}, 0)
              )
            `,
          })
          .returning({ id: llmUsage.id })
      : await executor.insert(llmUsage).values(values).returning({ id: llmUsage.id });

  const llmUsageId = inserted[0]?.id ?? null;
  if (llmUsageId === null) return null;

  const params: UsageRecordedParams = {
    llmUsageId,
    orgId: entry.orgId,
    userId: entry.userId ?? null,
    source: entry.source,
    ...resolveContext(entry),
    credentialSource: entry.credentialSource ?? null,
    model: entry.model ?? null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens ?? null,
    cacheWriteTokens: entry.cacheWriteTokens ?? null,
    costUsd: entry.costUsd,
    durationMs: entry.durationMs ?? null,
  };
  // A transactional caller (one that passed `deferEmit`) must NOT broadcast
  // inline: its row may still roll back, which would make this a phantom event.
  // Hand the built event to the collector and let the caller broadcast it after
  // commit. Everyone else emits inline the instant the row is durable.
  if (opts.deferEmit) {
    opts.deferEmit(params);
  } else {
    // Broadcast is fire-and-forget: handler errors are isolated inside emitEvent,
    // and a slow subscriber must not block the producer that just recorded usage.
    void emitEvent("onUsageRecorded", params);
  }

  return llmUsageId;
}

/**
 * Broadcast an `onUsageRecorded` event previously collected via
 * {@link RecordLlmUsageOptions.deferEmit}. A transactional caller MUST call this
 * only AFTER its transaction commits — never before — so the broadcast can
 * never announce a row a later rollback erased. Fire-and-forget by the same
 * contract as the inline path: handler errors are isolated inside `emitEvent`.
 */
export function emitUsageRecorded(event: UsageRecordedParams): void {
  void emitEvent("onUsageRecorded", event);
}
