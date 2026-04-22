// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Incremental reducer sink.
 *
 * Wraps {@link reduceEvents} so the aggregated {@link RunResult} is
 * available at any point during a run, not only after the runner
 * calls `reduceEvents(events)` in one shot. Consumers that need to
 * observe memories / state / output / report as they land (e.g. a
 * platform event sink that fans out to persistence) can compose this
 * sink with their own side-effect sink via {@link CompositeSink}.
 *
 * Behaviour matches `reduceEvents` semantics exactly:
 *   - memory.added    → push into memories
 *   - state.set       → replace state (last write wins)
 *   - output.emitted  → deep-merge objects, replace non-object values
 *   - report.appended → concatenate with `\n` separator
 *   - log.written     → append to logs when level + message are valid
 *
 * Third-party event types are ignored (they still pass through the
 * composed sink chain, they just do not fold into the snapshot).
 *
 * `finalize(result)` overrides the accumulated snapshot with the
 * runner-provided canonical result, so callers that read `snapshot()`
 * after finalize see exactly the same object the runner published.
 */

import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "../types/run-event.ts";
import type { RunResult } from "../types/run-result.ts";
import { emptyRunResult } from "../runner/reducer.ts";

export interface ReducerSinkHandle {
  readonly sink: EventSink;
  /** Current aggregated result; mutates as events arrive. */
  snapshot(): RunResult;
}

export function createReducerSink(): ReducerSinkHandle {
  let result: RunResult = emptyRunResult();

  const sink: EventSink = {
    handle: async (event: RunEvent): Promise<void> => {
      result = foldEvent(result, event);
    },
    finalize: async (final: RunResult): Promise<void> => {
      result = final;
    },
  };

  return {
    sink,
    snapshot(): RunResult {
      return result;
    },
  };
}

function foldEvent(current: RunResult, event: RunEvent): RunResult {
  switch (event.type) {
    case "memory.added": {
      if (typeof event.content !== "string") return current;
      return { ...current, memories: [...current.memories, { content: event.content }] };
    }
    case "state.set": {
      return { ...current, state: event.state ?? null };
    }
    case "output.emitted": {
      return { ...current, output: mergeOutput(current.output, event.data) };
    }
    case "report.appended": {
      if (typeof event.content !== "string") return current;
      const report =
        current.report === null ? event.content : `${current.report}\n${event.content}`;
      return { ...current, report };
    }
    case "log.written": {
      const level = event.level;
      const message = event.message;
      if (
        (level === "info" || level === "warn" || level === "error") &&
        typeof message === "string"
      ) {
        return {
          ...current,
          logs: [...current.logs, { level, message, timestamp: event.timestamp }],
        };
      }
      return current;
    }
    default:
      return current;
  }
}

function mergeOutput(previous: unknown, next: unknown): unknown {
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    return next;
  }
  return { ...previous, ...next };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
