// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run ordering buffer for sink events that arrive out of sequence.
 *
 * Implementations: Redis sorted set (multi-instance) and in-memory map
 * (single-instance / Tier 0). Both expose the exact same contract —
 * callers cannot tell which backing store they are talking to.
 *
 * Ordering contract: `pollLowest` returns the pending event with the
 * smallest sequence, never advancing past gaps — the caller decides
 * whether to drain on a gap (terminal finalize) or wait for the missing
 * sequence to arrive.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";

export interface BufferedEvent {
  sequence: number;
  event: RunEvent;
}

export interface EventBuffer {
  /** Insert an event into the run's ordering buffer, keyed by sequence. */
  put(runId: string, sequence: number, event: RunEvent, ttlSeconds: number): Promise<void>;

  /** Return the lowest-sequence event without removing it, or null when empty. */
  peekLowest(runId: string): Promise<BufferedEvent | null>;

  /** Remove the event at the given sequence. Idempotent. */
  remove(runId: string, sequence: number): Promise<void>;

  /** Drop the entire buffer for a run (post-finalize cleanup). Idempotent. */
  clear(runId: string): Promise<void>;

  /** Graceful shutdown — cleanup timers / connections. */
  shutdown(): Promise<void>;
}
