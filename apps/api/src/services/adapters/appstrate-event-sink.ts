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
import type { OrgScope } from "../../lib/scope.ts";
import { appendRunLog } from "../state/runs.ts";
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
  scope: OrgScope;
  runId: string;
}

export class AppstrateEventSink implements EventSink {
  readonly runId: string;
  private readonly scope: OrgScope;
  private readonly reducer: ReducerSinkHandle = createReducerSink();
  private readonly usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  private accumulatedCost = 0;
  private lastAdapterError: string | null = null;
  private finalResult: RunResult | null = null;

  constructor(opts: AppstrateEventSinkOptions) {
    this.scope = opts.scope;
    this.runId = opts.runId;
  }

  async handle(event: RunEvent): Promise<void> {
    // Delegate canonical events to the runtime reducer.
    await this.reducer.sink.handle(event);

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
        break;
      }

      default:
        // memory.added / state.set / third-party — reducer-only, no run_logs row.
        break;
    }
  }

  async finalize(result: RunResult): Promise<void> {
    await this.reducer.sink.finalize(result);
    this.finalResult = result;
  }

  /**
   * Platform-facing projection of the runtime snapshot + platform accumulators.
   * Safe to read at any point during or after a run.
   */
  get current(): Readonly<AggregatedRunState> {
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

function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens ?? 0;
  total.output_tokens += addition.output_tokens ?? 0;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}
