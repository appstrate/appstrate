// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { RunEvent } from "../types/run-event.ts";
import type { RunResult } from "../types/run-result.ts";

/**
 * Consumer of the stream of events emitted during a run.
 *
 * - `handle`: called once per {@link RunEvent}. The envelope carries its
 *   own `type`, `timestamp`, `runId`, and may be a third-party event
 *   (unknown to the runtime) — sinks MUST forward events they do not
 *   recognise without failing.
 * - `finalize`: called exactly once at the end of the run with the
 *   aggregated {@link RunResult}. Sinks may persist the result, close
 *   connections, flush buffers, etc.
 *
 * Implementations MUST be safe under back-pressure — the runtime awaits
 * each `handle` call, but may emit events faster than the sink can
 * forward them to its downstream.
 *
 * Specification: `afps-spec/spec.md` — {@link EventSink}.
 */
export interface EventSink {
  /**
   * Handle a single {@link RunEvent}. Called in sequence order,
   * sequentially awaited — the runtime will not call `handle` again
   * until the returned promise resolves.
   */
  handle(event: RunEvent): Promise<void>;

  /**
   * Called exactly once after the final event, before the runtime
   * exits. `result` is the reduction of all events into a single
   * aggregate. Use this to close files, flush HTTP queues, or persist
   * summaries.
   */
  finalize(result: RunResult): Promise<void>;
}
