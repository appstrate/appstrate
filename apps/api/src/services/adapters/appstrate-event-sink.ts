// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link EventSink} — consumes the 5 canonical AFPS
 * events and fans them out to the platform's persistence layer:
 *
 *   - `run_logs` table (one row per observable event, same shape the
 *     legacy in-route switch produced — preserves SSE + log history UI)
 *   - internal aggregator (structuredOutput / state / memories / report)
 *     which the route handler reads when the run ends to compute the
 *     final `result`, `state`, and memory write-back
 *
 * The sink itself performs NO status update, NO webhook dispatch, and NO
 * post-run metadata collection. Those remain the route handler's
 * responsibility until Phase E lands the AppstrateContainerRunner,
 * which will orchestrate the full lifecycle through the sink.
 *
 * See docs/architecture/AFPS_EXTENSION_ARCHITECTURE.md §6 for the
 * push-side contract.
 */

import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { AfpsEventEnvelope } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import type { OrgScope } from "../../lib/scope.ts";
import { appendRunLog } from "../state/runs.ts";

/**
 * Mutable projection the route handler reads after the run completes.
 * Mirrors the legacy local aggregators in `routes/runs.ts` so the
 * migration is drop-in — shape, semantics, and defaults are preserved.
 */
export interface AggregatedRunState {
  /** Deep-merged `output` event payloads (object-only merge; non-object replaces). */
  output: Record<string, unknown>;
  /** Last `set_state` payload. `null` if the agent never called `set_state`. */
  state: Record<string, unknown> | null;
  /** All `add_memory` contents, in arrival order. */
  memories: string[];
  /** Concatenated `report` contents, separated by `\n\n`. */
  report: string;
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
  };
  private finalResult: RunResult | null = null;

  constructor(opts: AppstrateEventSinkOptions) {
    this.scope = opts.scope;
    this.runId = opts.runId;
  }

  async onEvent(envelope: AfpsEventEnvelope): Promise<void> {
    const { event } = envelope;
    switch (event.type) {
      case "add_memory":
        this.aggregate.memories.push(event.content);
        break;

      case "set_state":
        this.aggregate.state = isPlainObject(event.state)
          ? event.state
          : // Preserve the route handler's long-standing behaviour of
            // accepting any JSON value via `set_state` by wrapping scalars
            // under a `value` key rather than discarding them.
            { value: event.state };
        break;

      case "output":
        if (isPlainObject(event.data)) {
          Object.assign(this.aggregate.output, event.data);
        } else if (event.data !== undefined) {
          // Non-object output replaces wholesale — matches the runtime
          // reducer's mergeOutput semantics for non-plain-object values.
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

      case "report":
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
        break;

      case "log":
        await appendRunLog(
          this.scope,
          this.runId,
          "progress",
          "progress",
          event.message,
          null,
          event.level,
        );
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
