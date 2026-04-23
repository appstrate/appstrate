// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * RunEvent → RunResult reducer.
 *
 * Consumes {@link RunEvent}s whose `type` is one of the reserved core
 * domains (`memory.added` / `state.set` / `output.emitted` /
 * `report.appended` / `log.written`). Events with any other `type` are
 * passed through silently — the sink still sees them, but they do not
 * contribute to the aggregated result.
 *
 * `foldEvent` is the single switch that knows how each canonical event
 * contributes to the aggregate. Both the batch reducer `reduceEvents`
 * and the incremental `createReducerSink` consume it.
 */

import type { RunEvent } from "../types/run-event.ts";
import type { RunError, RunResult } from "../types/run-result.ts";

export interface ReduceOptions {
  /** Optional error to attach after reduction (populated by the runner). */
  error?: RunError;
}

export function emptyRunResult(): RunResult {
  return {
    memories: [],
    state: null,
    output: null,
    report: null,
    logs: [],
  };
}

/**
 * Fold a single event into a mutable result accumulator. Consumers that
 * want an immutable pipeline can seed a fresh accumulator per call.
 */
export function foldEvent(result: RunResult, event: RunEvent): void {
  switch (event.type) {
    case "memory.added": {
      if (typeof event.content === "string") {
        result.memories.push({ content: event.content });
      }
      return;
    }
    case "state.set": {
      result.state = event.state ?? null;
      return;
    }
    case "output.emitted": {
      result.output = event.data ?? null;
      return;
    }
    case "report.appended": {
      if (typeof event.content === "string") {
        result.report =
          result.report === null ? event.content : `${result.report}\n${event.content}`;
      }
      return;
    }
    case "log.written": {
      const level = event.level;
      const message = event.message;
      if (
        (level === "info" || level === "warn" || level === "error") &&
        typeof message === "string"
      ) {
        result.logs.push({ level, message, timestamp: event.timestamp });
      }
      return;
    }
    default:
      // Third-party / unknown event types do not contribute — the sink
      // still sees them, they just do not fold into the summary.
      return;
  }
}

export function reduceEvents(events: Iterable<RunEvent>, opts: ReduceOptions = {}): RunResult {
  const result = emptyRunResult();
  for (const event of events) foldEvent(result, event);
  if (opts.error) result.error = opts.error;
  return result;
}
