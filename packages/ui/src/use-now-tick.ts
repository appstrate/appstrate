// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

const TICK_MS = 10_000;

const floored = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
// The snapshot is this stored value, never a fresh clock read: two reads in one
// render must agree, which `Date.now()` cannot promise across a tick boundary.
let now = floored();

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // Stale since the last subscriber left; React re-reads it once subscribed.
    now = floored();
    timer = setInterval(() => {
      now = floored();
      listeners.forEach((notify) => notify());
    }, TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => now;

/**
 * The current time for a relative label (« dans 3 min ») or a date grouping,
 * to within 20 s: the clock is floored to 10 s and re-read every 10 s, so the
 * label moves while nothing else re-renders the component. Every caller shares
 * one interval, stopped when the last one unmounts.
 */
export function useNowTick(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
