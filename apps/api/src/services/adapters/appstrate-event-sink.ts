// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link EventSink} — composition of the runtime
 * reducer (source of truth for canonical AFPS aggregation) with a
 * platform write-through that persists `run_logs`, snapshots token
 * usage onto the run row, and appends cost to the unified `llm_usage`
 * ledger.
 *
 * Event routing:
 *
 *   AFPS canonical (reserved domains) → reducer snapshot:
 *     memory.added / state.set / output.emitted / report.appended / log.written
 *
 *   Platform write-through (always, independent of reducer):
 *     output.emitted  → run_logs (result/output)
 *     report.appended → run_logs (result/report)
 *     log.written     → run_logs (progress/progress) with level
 *
 *   Platform-specific (`appstrate.*` namespace):
 *     appstrate.progress → run_logs (progress/progress) with message/data/level
 *     appstrate.error    → run_logs (system/adapter_error) + lastAdapterError
 *     appstrate.metric   → runs.tokenUsage snapshot (running total)
 *                         + llm_usage ledger row (source="runner")
 *
 * `runs.cost` is NEVER written here — it is the cached aggregate written
 * exactly once by `finalizeRun`. This sink is the single writer of the
 * `llm_usage` runner rows and the single reader/writer of
 * `runs.tokenUsage`.
 *
 * The sink performs NO status update, NO webhook dispatch, and NO
 * post-run metadata collection — those remain the route handler's
 * responsibility.
 */

import { createReducerSink, type ReducerSinkHandle } from "@appstrate/afps-runtime/sinks";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { isPlainObject } from "@appstrate/core/safe-json";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import type { AppScope } from "../../lib/scope.ts";
import { appendRunLog, updateRun } from "../state/runs.ts";
import { logger } from "../../lib/logger.ts";
import type { TokenUsage } from "./types.ts";

/**
 * Platform-facing projection of the runtime {@link RunResult} + the
 * platform-specific accumulators. Shapes match the DB persistence
 * expectations (memories as `string[]`, state/output as plain objects,
 * report as string, never null).
 */
export interface AggregatedRunState {
  /** Latest `output.emitted` object payload (replaces previous). Non-object payloads project to `{}`. */
  output: Record<string, unknown>;
  /** Last object `state.set` payload. `null` if never set or set to non-object. */
  state: Record<string, unknown> | null;
  /** All `memory.added` contents projected from the reducer, in arrival order. */
  memories: string[];
  /** Concatenated `report.appended` contents (runtime-canonical `\n` separator). */
  report: string;
  /** Accumulated token usage from `appstrate.metric` events. */
  usage: TokenUsage;
  /** Accumulated cost (USD) from `appstrate.metric` events. */
  cost: number;
  /** Most recent `appstrate.error.message`; drives the run's failure reason. */
  lastAdapterError: string | null;
}

export interface AppstrateEventSinkOptions {
  scope: AppScope;
  runId: string;
  /**
   * When `true`, skips the in-memory AFPS reducer entirely. The ingestion
   * route re-instantiates the sink per event and never reads `current` /
   * `result`, so the reducer is dead work on the hot path. Long-lived
   * callers (parity tests, in-process runners) leave this unset to keep
   * reading the canonical snapshot.
   */
  persistOnly?: boolean;
  /**
   * When `true`, `appstrate.metric` events write a runner-source row to
   * the `llm_usage` ledger. At most one runner row per run; concurrent
   * writers race via ON CONFLICT DO NOTHING. The ingestion path turns
   * this on; long-lived in-process runners (parity tests) leave it off.
   */
  writeLedger?: boolean;
}

export class AppstrateEventSink implements EventSink {
  readonly runId: string;
  private readonly scope: AppScope;
  private readonly reducer: ReducerSinkHandle | null;
  private readonly usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  private accumulatedCost = 0;
  private lastAdapterError: string | null = null;
  private finalResult: RunResult | null = null;
  private readonly writeLedger: boolean;

  constructor(opts: AppstrateEventSinkOptions) {
    this.scope = opts.scope;
    this.runId = opts.runId;
    this.reducer = opts.persistOnly ? null : createReducerSink();
    this.writeLedger = opts.writeLedger ?? false;
  }

  async handle(event: RunEvent): Promise<void> {
    // Delegate canonical events to the runtime reducer (skipped in
    // persist-only mode — ingestion fan-out doesn't need the snapshot).
    if (this.reducer) await this.reducer.sink.handle(event);

    // Platform write-through + metrics accumulation.
    switch (event.type) {
      case "output.emitted": {
        await appendRunLog(
          this.scope,
          this.runId,
          "result",
          "output",
          null,
          (event.data as Record<string, unknown> | null | undefined) ?? null,
          "info",
        );
        break;
      }

      case "report.appended": {
        if (typeof event.content === "string") {
          await appendRunLog(
            this.scope,
            this.runId,
            "result",
            "report",
            null,
            { content: event.content },
            "info",
          );
        }
        break;
      }

      case "log.written": {
        const level = event.level;
        const message = event.message;
        if (
          (level === "info" || level === "warn" || level === "error") &&
          typeof message === "string"
        ) {
          await appendRunLog(this.scope, this.runId, "progress", "progress", message, null, level);
        }
        break;
      }

      case "appstrate.progress": {
        const message = typeof event.message === "string" ? event.message : null;
        const data = isPlainObject(event.data) ? event.data : null;
        const level = resolveLogLevel(event.level) ?? "debug";
        await appendRunLog(this.scope, this.runId, "progress", "progress", message, data, level);
        break;
      }

      case "appstrate.error": {
        const message = typeof event.message === "string" ? event.message : null;
        const data = isPlainObject(event.data) ? event.data : null;
        if (message) this.lastAdapterError = message;
        await appendRunLog(
          this.scope,
          this.runId,
          "system",
          "adapter_error",
          message,
          data,
          "error",
        );
        break;
      }

      case "appstrate.metric": {
        const usage = isPlainObject(event.usage) ? (event.usage as TokenUsage) : null;
        const cost = typeof event.cost === "number" ? event.cost : null;

        // In-memory accumulators feed `sink.current` for long-lived sinks
        // (parity tests, in-process runners). Skip in persistOnly mode
        // where `sink.current` throws.
        if (this.reducer) {
          if (usage) accumulateUsage(this.usage, usage);
          if (cost !== null) this.accumulatedCost += cost;
        }

        // Token usage is a running-total snapshot on the run row.
        if (usage) {
          await updateRun(this.scope, this.runId, {
            tokenUsage: usage as unknown as Record<string, unknown>,
          });
        }
        // Ledger row — only the ingestion path opts in. Concurrent
        // writers race via ON CONFLICT DO NOTHING.
        if (this.writeLedger) {
          await writeRunnerLedgerRow(this.scope, this.runId, { cost, usage });
        }
        break;
      }

      default:
        // memory.added / state.set / third-party — reducer-only, no run_logs row.
        break;
    }
  }

  async finalize(result: RunResult): Promise<void> {
    if (this.reducer) await this.reducer.sink.finalize(result);
    this.finalResult = result;
  }

  /**
   * Platform-facing projection of the runtime snapshot + platform accumulators.
   * Safe to read at any point during or after a run.
   *
   * Throws when the sink was created with `persistOnly: true` — that
   * mode is reserved for fan-out-only consumers that never read back.
   */
  get current(): Readonly<AggregatedRunState> {
    if (!this.reducer) {
      throw new Error("AppstrateEventSink.current is unavailable in persistOnly mode");
    }
    const snapshot = this.reducer.snapshot();
    return {
      output: isPlainObject(snapshot.output) ? snapshot.output : {},
      state: isPlainObject(snapshot.state) ? snapshot.state : null,
      memories: snapshot.memories.map((m) => m.content),
      report: snapshot.report ?? "",
      usage: this.usage,
      cost: this.accumulatedCost,
      lastAdapterError: this.lastAdapterError,
    };
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
 * Write the runner-source row for a run to the `llm_usage` ledger.
 *
 * The metric event carries the runner's full LLM cost + token usage for
 * the run. At most one runner row per run — concurrent writers (the
 * `appstrate.metric` event handler and the finalize-time fallback)
 * race via the partial unique index `uq_llm_usage_runner_run_id`;
 * whichever lands first wins, the other no-ops.
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
      .onConflictDoNothing();
  } catch (err) {
    logger.error("Failed to write runner ledger row", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether a runner-source row has already been persisted for this run.
 * Used by the finalize-time fallback to decide whether to synthesise the
 * row or trust the metric event handler that already ran.
 */
export async function hasRunnerLedgerRow(runId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: llmUsage.id })
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")))
      .limit(1);
    return row !== undefined;
  } catch (err) {
    logger.warn("Failed to read runner ledger; assuming row absent", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens ?? 0;
  total.output_tokens += addition.output_tokens ?? 0;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}
