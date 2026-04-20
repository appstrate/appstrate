// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Event → {@link RunResult} reducer — the canonical way to aggregate a
 * stream of {@link AfpsEvent} values into the final run snapshot.
 *
 * Semantics (kept in lockstep with `AFPS_EXTENSION_ARCHITECTURE.md` §6):
 *
 * - `add_memory` appends a `{ content }` entry to `memories`
 * - `set_state` overwrites `state` (last-write-wins)
 * - `output` deep-merges object values (JSON merge-patch); scalars and
 *   arrays replace the previous output entirely
 * - `report` concatenates into `report` separated by `\n`
 * - `log` appends to `logs` with the provided timestamp (defaults to now)
 *
 * Pure function — no I/O, no mutation of inputs.
 */

import type { AfpsEvent } from "../types/afps-event.ts";
import type { RunError, RunResult } from "../types/run-result.ts";

export interface ReduceOptions {
  /**
   * Timestamp applied to log entries that the runtime surfaces through
   * the reducer (events themselves don't carry a timestamp in v1).
   * Defaults to `Date.now()`.
   */
  nowMs?: () => number;
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

export function reduceEvents(events: Iterable<AfpsEvent>, opts: ReduceOptions = {}): RunResult {
  const now = opts.nowMs ?? Date.now;
  const result = emptyRunResult();

  for (const event of events) {
    switch (event.type) {
      case "add_memory":
        result.memories.push({ content: event.content });
        break;
      case "set_state":
        result.state = event.state;
        break;
      case "output":
        result.output = mergeOutput(result.output, event.data);
        break;
      case "report":
        result.report =
          result.report === null ? event.content : `${result.report}\n${event.content}`;
        break;
      case "log":
        result.logs.push({ level: event.level, message: event.message, timestamp: now() });
        break;
    }
  }

  if (opts.error) {
    result.error = opts.error;
  }
  return result;
}

/**
 * JSON merge-patch on plain objects. Non-object values replace the
 * previous output wholesale (matching the spec: arrays and scalars are
 * not deep-merged).
 */
function mergeOutput(previous: unknown, next: unknown): unknown {
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    return next;
  }
  return { ...previous, ...next };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
