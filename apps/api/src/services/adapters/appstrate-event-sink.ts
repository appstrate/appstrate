// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link EventSink} — composition of the runtime
 * reducer (source of truth for canonical AFPS aggregation) with a
 * platform write-through that persists `run_logs` and accumulates
 * platform-specific metrics (token usage, cost, adapter error).
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
 *     appstrate.metric   → usage + cost accumulators (no run_logs row)
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
import type { AppScope } from "../../lib/scope.ts";
import { appendRunLog, updateRun } from "../state/runs.ts";
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
}

export class AppstrateEventSink implements EventSink {
  readonly runId: string;
  private readonly scope: AppScope;
  private readonly reducer: ReducerSinkHandle | null;
  private readonly usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  private accumulatedCost = 0;
  private lastAdapterError: string | null = null;
  private finalResult: RunResult | null = null;

  constructor(opts: AppstrateEventSinkOptions) {
    this.scope = opts.scope;
    this.runId = opts.runId;
    this.reducer = opts.persistOnly ? null : createReducerSink();
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
        if (isPlainObject(event.usage)) {
          accumulateUsage(this.usage, event.usage as TokenUsage);
        }
        if (typeof event.cost === "number") {
          this.accumulatedCost += event.cost;
        }
        // Persist the running totals to the run row atomically. The sink is
        // instantiated per-event in the unified-runner ingestion path, so
        // the in-memory accumulators above would reset across requests —
        // the source of truth for usage/cost lives on the `runs` row.
        await persistRunMetrics(this.scope, this.runId, {
          usage: isPlainObject(event.usage) ? (event.usage as TokenUsage) : null,
          cost: typeof event.cost === "number" ? event.cost : null,
        });
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
 * Atomically merge a metric event's usage + cost into the run row. Uses
 * Postgres JSONB concatenation for usage (per-key add isn't a primitive,
 * so the delta is whole-object merged — downstream consumers sum the keys
 * at read time) and a scalar increment for cost.
 *
 * Single writer ⇒ no race. For the unified-runner architecture, the
 * run-event-ingestion route serializes all events per-run via its
 * ordering buffer, so concurrent updates on the same row are impossible.
 */
async function persistRunMetrics(
  scope: AppScope,
  runId: string,
  delta: { usage: TokenUsage | null; cost: number | null },
): Promise<void> {
  const updates: {
    tokenUsage?: Record<string, unknown>;
    cost?: number;
  } = {};
  if (delta.usage) {
    // Whole-object replacement is correct because HttpSink emits running
    // totals, not deltas. Runners that emit deltas need to be fixed at
    // the emit site.
    updates.tokenUsage = delta.usage as unknown as Record<string, unknown>;
  }
  if (delta.cost !== null) {
    updates.cost = delta.cost;
  }
  if (Object.keys(updates).length === 0) return;
  await updateRun(scope, runId, updates);
}

function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens ?? 0;
  total.output_tokens += addition.output_tokens ?? 0;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}
