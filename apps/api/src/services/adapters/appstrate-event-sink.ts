// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link EventSink} — consumes the canonical AFPS
 * reserved-domain events and fans them out to the platform's
 * persistence layer:
 *
 *   - `run_logs` table (one row per observable event, same shape the
 *     legacy in-route switch produced — preserves SSE + log history UI)
 *   - internal aggregator (structuredOutput / state / memories / report)
 *     which the route handler reads when the run ends to compute the
 *     final `result`, `state`, and memory write-back
 *
 * The sink itself performs NO status update, NO webhook dispatch, and NO
 * post-run metadata collection. Those remain the route handler's
 * responsibility.
 *
 * AFPS 1.3 surface: the primary entrypoint is `handle(event: RunEvent)` —
 * the open envelope spec'd in afps-spec/schema/src/interfaces.ts. Legacy
 * `onEvent(envelope)` is kept for compatibility with callers still on the
 * pre-1.3 surface (notably existing unit tests that bypass the runtime
 * and call the sink directly). Both paths feed the same aggregator.
 */

import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { AfpsEventEnvelope } from "@appstrate/afps-runtime/types";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { toRunEvent } from "@appstrate/afps-runtime/types";
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

  /**
   * AFPS 1.3 primary entrypoint — open {@link RunEvent} envelope. Core
   * reserved-domain events (memory.added / state.set / output.emitted /
   * report.appended / log.written) feed the aggregator; other event
   * types pass through silently (third-party tools do not contribute
   * to the canonical RunResult projection).
   */
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

      default:
        // Third-party event — no canonical projection. Runners that want
        // to observe third-party events can compose with CompositeSink.
        break;
    }
  }

  /**
   * Pre-1.3 entrypoint — lifts the legacy envelope into an open RunEvent
   * and delegates to {@link handle}. Kept so existing tests and callers
   * that bypass the runtime (and therefore miss the runtime's preferred
   * `handle` path) keep working without modification.
   *
   * @deprecated use {@link handle} directly.
   */
  async onEvent(envelope: AfpsEventEnvelope): Promise<void> {
    await this.handle(toRunEvent({ event: envelope.event, runId: envelope.runId }));
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
