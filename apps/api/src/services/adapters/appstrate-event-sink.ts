// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link EventSink} — consumes {@link RunEvent}s emitted
 * by the run adapter and fans them out to the platform's persistence layer:
 *
 *   - `run_logs` table (one row per observable event, same shape the
 *     legacy in-route switch produced — preserves SSE + log history UI)
 *   - internal aggregator (output / state / memories / report / usage /
 *     cost / lastAdapterError) which the route handler reads when the
 *     run ends to compute the final `result`, `state`, memory write-back,
 *     and failure reason.
 *
 * The sink itself performs NO status update, NO webhook dispatch, and NO
 * post-run metadata collection. Those remain the route handler's
 * responsibility.
 *
 * Event routing:
 *
 *   AFPS canonical (reserved domains):
 *     memory.added    → aggregate.memories
 *     state.set       → aggregate.state
 *     output.emitted  → aggregate.output + run_logs (result/output)
 *     report.appended → aggregate.report + run_logs (result/report)
 *     log.written     → run_logs (progress) with level
 *
 *   Platform-specific (appstrate.* namespace):
 *     appstrate.progress → run_logs (progress/progress) with message/data/level
 *     appstrate.error    → aggregate.lastAdapterError + run_logs (system/adapter_error)
 *     appstrate.metric   → aggregate.usage / aggregate.cost (no run_logs row)
 */

import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import type { OrgScope } from "../../lib/scope.ts";
import { appendRunLog } from "../state/runs.ts";
import type { TokenUsage } from "./types.ts";

/**
 * Mutable projection the route handler reads after the run completes.
 * Mirrors the legacy local aggregators in `routes/runs.ts` so the
 * migration is drop-in — shape, semantics, and defaults are preserved.
 */
export interface AggregatedRunState {
  /** Deep-merged `output.emitted` payloads (object-only merge; non-object replaces). */
  output: Record<string, unknown>;
  /** Last `state.set` payload. `null` if the agent never called `set_state`. */
  state: Record<string, unknown> | null;
  /** All `memory.added` contents, in arrival order. */
  memories: string[];
  /** Concatenated `report.appended` contents, separated by `\n\n`. */
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
  private readonly aggregate: AggregatedRunState = {
    output: {},
    state: null,
    memories: [],
    report: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    cost: 0,
    lastAdapterError: null,
  };
  private finalResult: RunResult | null = null;

  constructor(opts: AppstrateEventSinkOptions) {
    this.scope = opts.scope;
    this.runId = opts.runId;
  }

  async handle(event: RunEvent): Promise<void> {
    switch (event.type) {
      case "memory.added": {
        if (typeof event.content === "string") {
          this.aggregate.memories.push(event.content);
        }
        break;
      }

      case "state.set": {
        this.aggregate.state = isPlainObject(event.state)
          ? event.state
          : event.state === undefined
            ? this.aggregate.state
            : // Preserve the route handler's long-standing behaviour of
              // accepting any JSON value via `set_state` by wrapping scalars
              // under a `value` key rather than discarding them.
              { value: event.state };
        break;
      }

      case "output.emitted": {
        if (isPlainObject(event.data)) {
          Object.assign(this.aggregate.output, event.data);
        } else if (event.data !== undefined) {
          this.aggregate.output = { value: event.data };
        }
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
          this.aggregate.report += (this.aggregate.report ? "\n\n" : "") + event.content;
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
        if (message) this.aggregate.lastAdapterError = message;
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
          accumulateUsage(this.aggregate.usage, event.usage as TokenUsage);
        }
        if (typeof event.cost === "number") {
          this.aggregate.cost += event.cost;
        }
        break;
      }

      default:
        // Third-party event — no canonical projection. Runners that want
        // to observe third-party events can compose with CompositeSink.
        break;
    }
  }

  async finalize(result: RunResult): Promise<void> {
    this.finalResult = result;
  }

  /** Snapshot of the aggregated mutable state. */
  get current(): Readonly<AggregatedRunState> {
    return this.aggregate;
  }

  /**
   * The canonical {@link RunResult} produced by the runtime reducer.
   * `null` until `finalize` has been called.
   */
  get result(): RunResult | null {
    return this.finalResult;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
