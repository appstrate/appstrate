// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { AfpsEventEnvelope } from "../types/afps-event.ts";
import type { RunEvent } from "../types/run-event.ts";
import type { RunResult } from "../types/run-result.ts";

/**
 * Consumer of the stream of events emitted during a run.
 *
 * Two orthogonal flows:
 *
 * - `onEvent`: legacy pre-1.3 call path — called once per event with the
 *   runtime-assigned envelope. Implementations SHOULD continue to accept
 *   it for compatibility with AFPS 1.0–1.2 runners.
 * - `handle` (AFPS 1.3+): called once per open-envelope {@link RunEvent}.
 *   The envelope carries its own `type`, `timestamp`, `runId`, and may
 *   be a third-party event (unknown to the runtime). Prefer this when
 *   building new sinks — it is the spec-aligned contract.
 * - `finalize`: called exactly once at the end of the run with the
 *   aggregated {@link RunResult}. Sinks may persist the result, close
 *   connections, flush buffers, etc.
 *
 * The runtime calls whichever method the sink implements. When both are
 * present, `handle` takes precedence and `onEvent` is NOT also called —
 * sinks that need the legacy envelope should implement `onEvent` alone
 * and skip `handle`. This is the migration path from 1.0–1.2 sinks to
 * spec-native 1.3 sinks.
 *
 * Implementations MUST be safe under back-pressure — the runtime may
 * emit events faster than the sink can forward them.
 *
 * Specification: `afps-spec/spec.md` — {@link EventSink}.
 */
export interface EventSink {
  /**
   * AFPS 1.3+ handler — open-envelope {@link RunEvent}. Called in
   * sequence order, sequentially awaited — the runtime will not call
   * `handle` again until the returned promise resolves.
   *
   * Optional for back-compat with sinks authored against 1.0–1.2.
   */
  handle?(event: RunEvent): Promise<void>;

  /**
   * Handle a single legacy event envelope (pre-1.3 surface).
   * Called in sequence order, sequentially awaited.
   *
   * Optional — new sinks SHOULD implement {@link handle} instead.
   * Kept for compatibility with existing AFPS 1.0–1.2 sinks.
   */
  onEvent?(envelope: AfpsEventEnvelope): Promise<void>;

  /**
   * Called exactly once after the final event, before the runtime
   * exits. `result` is the reduction of all events into a single
   * aggregate. Use this to close files, flush HTTP queues, or persist
   * summaries.
   */
  finalize(result: RunResult): Promise<void>;
}
