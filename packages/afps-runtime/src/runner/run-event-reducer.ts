// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * RunEvent → RunResult reducer for the AFPS 1.3 open envelope.
 *
 * Mirrors the semantics of the legacy {@link reduceEvents} reducer
 * (`./reducer.ts`) but consumes open-envelope {@link RunEvent}s whose
 * `type` is one of the reserved core-domain values
 * (memory.added / state.set / output.emitted / report.appended / log.written).
 * Events with any other `type` are passed through silently — the sink
 * still sees them, but they do not contribute to the aggregated result.
 *
 * Pure function — no IO, no mutation of inputs.
 */

import type { RunEvent } from "../types/run-event.ts";
import type { RunError, RunResult } from "../types/run-result.ts";

export interface ReduceRunEventsOptions {
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

export function reduceRunEvents(
  events: Iterable<RunEvent>,
  opts: ReduceRunEventsOptions = {},
): RunResult {
  const result = emptyRunResult();

  for (const event of events) {
    switch (event.type) {
      case "memory.added": {
        if (typeof event.content === "string") {
          result.memories.push({ content: event.content });
        }
        break;
      }
      case "state.set": {
        result.state = event.state ?? null;
        break;
      }
      case "output.emitted": {
        result.output = mergeOutput(result.output, event.data);
        break;
      }
      case "report.appended": {
        if (typeof event.content === "string") {
          result.report =
            result.report === null ? event.content : `${result.report}\n${event.content}`;
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
          result.logs.push({ level, message, timestamp: event.timestamp });
        }
        break;
      }
      default:
        // Third-party / unknown event types do not contribute — the sink
        // still sees them, they just do not fold into the summary.
        break;
    }
  }

  if (opts.error) {
    result.error = opts.error;
  }
  return result;
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
