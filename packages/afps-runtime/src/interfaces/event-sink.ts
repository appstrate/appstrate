// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { AfpsEventEnvelope } from "../types/afps-event.ts";
import type { RunResult } from "../types/run-result.ts";

/**
 * Consumer of the stream of events emitted during a run.
 *
 * Two orthogonal flows:
 *
 * - `onEvent`: called once per event as the run streams. Sinks stream to
 *   a file, HTTP endpoint, console, or fan out to multiple destinations.
 * - `finalize`: called exactly once at the end of the run with the
 *   aggregated {@link RunResult}. Sinks may persist the result, close
 *   connections, flush buffers, etc.
 *
 * Implementations MUST be safe under back-pressure — the runtime may
 * emit events faster than the sink can forward them.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §6.
 */
export interface EventSink {
  /**
   * Handle a single event. Called in sequence order, sequentially
   * awaited — the runtime will not call `onEvent` again until the
   * returned promise resolves. Implementations that need concurrency
   * should buffer internally.
   */
  onEvent(envelope: AfpsEventEnvelope): Promise<void>;

  /**
   * Called exactly once after the final event, before the runtime
   * exits. `result` is the reduction of all events into a single
   * aggregate. Use this to close files, flush HTTP queues, or persist
   * summaries.
   */
  finalize(result: RunResult): Promise<void>;
}
