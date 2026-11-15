// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * RunEvent → RunResult reducer.
 *
 * Aggregates `output.emitted` into the {@link RunResult}.
 * Every other event is passed through silently: the sink still sees it, but
 * it does not contribute to the aggregated result.
 */

import type { RunEvent } from "@afps-spec/types";
import type { RunError, RunResult, TokenUsage } from "../types/run-result.ts";

export interface ReduceOptions {
  /** Optional error to attach after reduction (populated by the runner). */
  error?: RunError;
}

export function emptyRunResult(): RunResult {
  return {
    output: null,
  };
}

/** A fresh all-zero {@link TokenUsage} accumulator — shared by the runner
 * event mappers so the empty-usage shape has one definition. */
export function zeroTokenUsage(): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/**
 * Fold a single event into a mutable result accumulator: an `output.emitted`
 * carrying `data` replaces `result.output` (replace-on-emit).
 */
export function foldEvent(result: RunResult, event: RunEvent): void {
  if (event.type === "output.emitted" && event.data !== undefined) result.output = event.data;
}

export function reduceEvents(events: Iterable<RunEvent>, opts: ReduceOptions = {}): RunResult {
  const result = emptyRunResult();
  for (const event of events) foldEvent(result, event);
  if (opts.error) result.error = opts.error;
  return result;
}
