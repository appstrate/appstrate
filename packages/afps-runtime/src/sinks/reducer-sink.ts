// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Incremental reducer sink.
 *
 * Folds each incoming event into the accumulator via the shared
 * {@link foldEvent} helper so the aggregated {@link RunResult} is
 * available at any point during a run, not only after the runner calls
 * `reduceEvents(events)` in one shot. Consumers that need to observe
 * memories / state / output / report as they land (e.g. a platform
 * event sink that fans out to persistence) can compose this sink with
 * their own side-effect sink via {@link CompositeSink}.
 *
 * `finalize(result)` overrides the accumulated snapshot with the
 * runner-provided canonical result, so callers that read `snapshot()`
 * after finalize see exactly the object the runner published.
 */

import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "../types/run-event.ts";
import type { RunResult } from "../types/run-result.ts";
import { emptyRunResult, foldEvent } from "../runner/reducer.ts";

export interface ReducerSinkHandle {
  readonly sink: EventSink;
  /** Current aggregated result; mutates as events arrive. */
  snapshot(): RunResult;
}

export function createReducerSink(): ReducerSinkHandle {
  let result: RunResult = emptyRunResult();

  const sink: EventSink = {
    handle: async (event: RunEvent): Promise<void> => {
      foldEvent(result, event);
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
