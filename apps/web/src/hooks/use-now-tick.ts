// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

const TICK_MS = 10_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((notify) => notify()), TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The clock floored to the tick: stable between ticks, as a snapshot must be. */
function snapshot(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

/**
 * The current time for a relative label (« dans 3 min »), re-read every 10 s
 * so the label moves while nothing else re-renders the component. Every
 * mounted label shares one interval, stopped when the last one unmounts.
 */
export function useNowTick(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
