// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link EventSink} implementations — composition of
 * the runtime reducer (source of truth for canonical AFPS aggregation)
 * with a platform write-through that persists `run_logs`, snapshots
 * token usage onto the run row, and appends cost to the unified
 * `llm_usage` ledger.
 *
 * Two flavours, no flags:
 *
 *   {@link PersistingEventSink} — fan-out only. Used by the ingestion
 *     hot path: each request rebuilds one sink, calls `handle()`, and
 *     drops it. No reducer is constructed, no in-memory state is kept.
 *
 *   {@link AggregatingEventSink} — long-lived sink for parity tests
 *     and in-process runners that read back `snapshot()` / `result`
 *     between events. Wraps {@link PersistingEventSink} and feeds the
 *     same events into a runtime reducer + token/cost accumulators.
 *
 * Splitting the two eliminates the previous `persistOnly` flag whose
 * `current` getter threw — every method on every public surface is now
 * total. Liskov substitution: an `AggregatingEventSink` is a
 * `PersistingEventSink` with extra read-back capabilities, never less.
 *
 * Event routing (identical for both sinks):
 *
 *   AFPS canonical (reserved domains) → reducer snapshot (aggregating only):
 *     memory.added / pinned.set / output.emitted / log.written
 *
 *   Platform write-through (always, both sinks):
 *     output.emitted  → run_logs (result/output)
 *     log.written     → run_logs (progress/progress) with level
 *
 *   Platform-specific (`appstrate.*` namespace):
 *     appstrate.progress → run_logs (progress/progress) with message/data/level
 *     appstrate.error    → run_logs (system/adapter_error) + lastAdapterError
 *     appstrate.metric   → runs.tokenUsage snapshot (running total)
 *                         + llm_usage ledger row (source="runner")
 *                         + schedules a throttled `run_metric` broadcast
 *                           which also persists `cost_so_far` onto the
 *                           run row (monotonic-max guarded)
 *
 * These sinks are the single writer of the `llm_usage` runner rows and
 * the single reader/writer of `runs.tokenUsage`. `runs.cost` is cached
 * aggregate of `llm_usage` and is refreshed on two paths: the throttled
 * broadcaster (during streaming, via {@link scheduleRunMetricBroadcast})
 * and `finalizeRun` (terminal write). Both writers use a monotonic guard
 * so the recorded value never regresses.
 */

import { createReducerSink, type ReducerSinkHandle } from "@appstrate/afps-runtime/sinks";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { isPlainObject } from "@appstrate/core/safe-json";
import { db, type Db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { sql } from "drizzle-orm";
import type { AppScope } from "../../lib/scope.ts";
import { appendRunLog, updateRun } from "../state/runs.ts";
import { logger } from "../../lib/logger.ts";
import { accumulateTokenUsage } from "@appstrate/shared-types";
import { getErrorMessage } from "@appstrate/core/errors";
import type { TokenUsage } from "./types.ts";
import { scheduleRunMetricBroadcast } from "../run-metric-broadcaster.ts";

export interface PersistingEventSinkOptions {
  scope: AppScope;
  runId: string;
  /**
   * When `true`, `appstrate.metric` events write a runner-source row to
   * the `llm_usage` ledger. At most one runner row per run; concurrent
   * writers race via ON CONFLICT DO NOTHING. The ingestion path turns
   * this on; long-lived in-process runners (parity tests) leave it off
   * — they go through {@link AggregatingEventSink} which never enables
   * ledger writes.
   */
  writeLedger?: boolean;
}

export type AggregatingEventSinkOptions = Pick<PersistingEventSinkOptions, "scope" | "runId">;

/**
 * Persists each {@link RunEvent} to `run_logs` + (for `appstrate.metric`)
 * to `runs.tokenUsage` + the `llm_usage` ledger.
 *
 * Stateless across events: a fresh instance is built per ingested
 * envelope by the route handler. Calls to this sink are total —
 * no method ever throws because of an unsupported mode.
 */
export class PersistingEventSink implements EventSink {
  readonly runId: string;
  protected readonly scope: AppScope;
  protected lastAdapterError: string | null = null;
  private readonly writeLedger: boolean;

  constructor(opts: PersistingEventSinkOptions) {
    this.scope = opts.scope;
    this.runId = opts.runId;
    this.writeLedger = opts.writeLedger ?? false;
  }

  async handle(event: RunEvent): Promise<void> {
    await this.persist(event);
  }

  async finalize(_result: RunResult): Promise<void> {
    // Persistence-only sink — finalize is the route handler's job.
    // The interface contract requires the method, so we no-op.
  }

  /**
   * Last `appstrate.error.message` observed during the lifetime of this
   * sink instance. Per-instance — short-lived in the ingestion path.
   */
  get lastError(): string | null {
    return this.lastAdapterError;
  }

  protected async persist(event: RunEvent): Promise<void> {
    const adapterError = await persistRunEvent(db, this.scope, this.runId, event, {
      writeLedger: this.writeLedger,
    });
    if (adapterError !== null) this.lastAdapterError = adapterError;
  }
}

/**
 * Dispatch one {@link RunEvent} through the platform write-through table.
 * Extracted so the ingestion hot path can run the dispatch inside a
 * Drizzle transaction (passing `tx` as the executor) — that way the CAS
 * advance of `runs.last_event_sequence` and the `run_logs` INSERT
 * commit-or-roll-back atomically. A transient INSERT failure no longer
 * leaves a sequence advanced with no log row to back it.
 *
 * Returns the `appstrate.error.message` if this event was one, so the
 * caller can update its own `lastAdapterError` cache.
 */
export async function persistRunEvent(
  executor: Db,
  scope: AppScope,
  runId: string,
  event: RunEvent,
  opts: { writeLedger?: boolean } = {},
): Promise<string | null> {
  switch (event.type) {
    case "output.emitted": {
      await appendRunLog(
        scope,
        runId,
        "result",
        "output",
        null,
        (event.data as Record<string, unknown> | null | undefined) ?? null,
        "info",
        executor,
      );
      return null;
    }

    case "log.written": {
      const level = event.level;
      const message = event.message;
      if (
        (level === "info" || level === "warn" || level === "error") &&
        typeof message === "string"
      ) {
        await appendRunLog(scope, runId, "progress", "progress", message, null, level, executor);
      }
      return null;
    }

    case "report.appended": {
      // `@appstrate/report` system tool — appends one Markdown chunk
      // to the run's user-facing report. Stored as `type='result'
      // event='report'` so the UI can find it in O(rows-with-event-report)
      // instead of scanning every log payload. Each emit is its own
      // row; concatenation is the renderer's job (the UI joins them
      // in id order). Without this case the content was silently
      // dropped (default branch) and the agent's report never
      // surfaced anywhere.
      const content = typeof event.content === "string" ? event.content : null;
      if (content !== null) {
        await appendRunLog(scope, runId, "result", "report", null, { content }, "info", executor);
      }
      return null;
    }

    case "appstrate.progress": {
      const message = typeof event.message === "string" ? event.message : null;
      const data = isPlainObject(event.data) ? event.data : null;
      const level = resolveLogLevel(event.level) ?? "debug";
      await appendRunLog(scope, runId, "progress", "progress", message, data, level, executor);
      return null;
    }

    case "appstrate.error": {
      const message = typeof event.message === "string" ? event.message : null;
      const data = isPlainObject(event.data) ? event.data : null;
      await appendRunLog(scope, runId, "system", "adapter_error", message, data, "error", executor);
      return message;
    }

    case "appstrate.metric": {
      const usage = isPlainObject(event.usage) ? (event.usage as TokenUsage) : null;
      const cost = typeof event.cost === "number" ? event.cost : null;

      // Token usage is a running-total snapshot on the run row.
      if (usage) {
        await updateRun(
          scope,
          runId,
          { tokenUsage: usage as unknown as Record<string, unknown> },
          executor,
        );
      }
      // Ledger row — only the ingestion path opts in. The runner emits
      // cumulative running totals on each metric event, so concurrent
      // writers (a later metric event, the finalize-time fallback)
      // UPSERT the row with monotonic-max semantics. The ledger write
      // is best-effort by its own contract (see writeRunnerLedgerRow's
      // try/catch) so it never aborts the surrounding transaction.
      if (opts.writeLedger) {
        await writeRunnerLedgerRow(scope, runId, { cost, usage });
        // Best-effort live broadcast — never blocks the ingestion hot
        // path nor fails it. The broadcaster throttles per-run to
        // avoid flooding SSE subscribers under bursty metric emission
        // (e.g. tool-heavy turns).
        scheduleRunMetricBroadcast(runId);
      }
      return null;
    }

    default:
      // memory.added / pinned.set / third-party — no run_logs row.
      return null;
  }
}

/**
 * Long-lived sink that wraps {@link PersistingEventSink} with an
 * additional in-memory reducer + token/cost accumulators. Use when a
 * caller needs to read `snapshot()` / `result` / `usage` / `cost`
 * between events (parity tests, in-process runners). The ingestion
 * path does not need this — it builds a fresh persisting sink per
 * event.
 */
export class AggregatingEventSink extends PersistingEventSink {
  private readonly reducer: ReducerSinkHandle;
  private readonly accumulatedUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  private accumulatedCost = 0;
  private finalResult: RunResult | null = null;

  constructor(opts: AggregatingEventSinkOptions) {
    // Aggregating sinks never write the ledger — they are never on the
    // ingestion hot path. Pass `writeLedger: false` explicitly so the
    // base class's metric handler skips the ledger write.
    super({ ...opts, writeLedger: false });
    this.reducer = createReducerSink();
  }

  override async handle(event: RunEvent): Promise<void> {
    // 1. Feed the runtime reducer so `snapshot()` reflects every event.
    await this.reducer.sink.handle(event);

    // 2. Accumulate platform-specific running totals from metric events.
    if (event.type === "appstrate.metric") {
      const usage = isPlainObject(event.usage) ? (event.usage as TokenUsage) : null;
      const cost = typeof event.cost === "number" ? event.cost : null;
      if (usage) accumulateTokenUsage(this.accumulatedUsage, usage);
      if (cost !== null) this.accumulatedCost += cost;
    }

    // 3. Run the persistence write-through (delegates to base).
    await super.handle(event);
  }

  override async finalize(result: RunResult): Promise<void> {
    await this.reducer.sink.finalize(result);
    this.finalResult = result;
  }

  /**
   * Live snapshot of the runtime reducer — memories, state, output,
   * logs. The native {@link RunResult} shape, no platform
   * projection. Total: never throws.
   */
  snapshot(): RunResult {
    return this.reducer.snapshot();
  }

  /** Accumulated token usage across all `appstrate.metric` events. */
  get usage(): Readonly<TokenUsage> {
    return this.accumulatedUsage;
  }

  /** Accumulated cost (USD) across all `appstrate.metric` events. */
  get cost(): number {
    return this.accumulatedCost;
  }

  /** Canonical {@link RunResult} — `null` until `finalize` has been called. */
  get result(): RunResult | null {
    return this.finalResult;
  }
}

function resolveLogLevel(value: unknown): "debug" | "info" | "warn" | "error" | null {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

/**
 * Write (upsert) the runner-source row for a run in the `llm_usage` ledger.
 *
 * The runner emits cumulative running totals on every `appstrate.metric`
 * event, so the row tracks the latest total seen — concurrent writers
 * (a later metric event, the finalize-time fallback) UPSERT into the
 * partial unique index `uq_llm_usage_runner_run_id`. The conflict
 * clause is monotonic: an UPDATE only takes effect when the incoming
 * `cost_usd` is at least as large as the stored value, so:
 *
 *   - rapid-fire metric events keep the row in sync with the latest total
 *   - a finalize-fallback emit with a smaller `result.cost` (e.g. when
 *     a fresh metric already landed) cannot regress the bill
 *   - reorder is safe — the highest-seen cost wins regardless of arrival
 *     order
 *
 * Best-effort: metric persistence MUST NOT fail the ingestion path.
 * Errors are logged.
 */
export async function writeRunnerLedgerRow(
  scope: AppScope,
  runId: string,
  row: {
    cost: number | null;
    usage: TokenUsage | null;
  },
): Promise<void> {
  // Skip degenerate events with neither usage nor cost — nothing to bill
  // or audit.
  if (row.cost === null && !row.usage) return;

  try {
    await db
      .insert(llmUsage)
      .values({
        source: "runner",
        orgId: scope.orgId,
        runId,
        inputTokens: row.usage?.input_tokens ?? 0,
        outputTokens: row.usage?.output_tokens ?? 0,
        cacheReadTokens: row.usage?.cache_read_input_tokens ?? null,
        cacheWriteTokens: row.usage?.cache_creation_input_tokens ?? null,
        costUsd: row.cost ?? 0,
      })
      // Upsert via the partial unique index. `setWhere` keeps the
      // update monotonic — only the highest-seen cumulative total ever
      // wins, so out-of-order metric events and the finalize fallback
      // can never regress the recorded cost. Token columns are bumped
      // alongside the cost so the snapshot stays internally consistent
      // (cost ≥ stored cost ⇒ tokens are at least as large too).
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
        setWhere: sql`EXCLUDED.cost_usd >= ${llmUsage.costUsd}`,
      });
  } catch (err) {
    logger.error("Failed to write runner ledger row", {
      runId,
      error: getErrorMessage(err),
    });
  }
}
