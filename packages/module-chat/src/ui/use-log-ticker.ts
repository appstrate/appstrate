// SPDX-License-Identifier: Apache-2.0

/**
 * Paces the run line's single-line log display. Logs arrive in bursts (an agent emits several
 * lines in one tick), which would flash through the line faster than the eye can read: once the
 * line shows an entry, each newer one is held at least `dwellMs` before the next.
 *
 * The first batch the line sees lands on its last entry: a line mounted on a run that already
 * logged N rows shows where the run is, not a replay of its history. Only entries arriving after
 * that are paced.
 *
 * The effect only schedules: `setIndex` runs in the timer, and the render-phase adjustment below is
 * React's documented one (same as `use-run-log-stream.ts`).
 */

import { useEffect, useState } from "react";
import type { VisibleLogEntry } from "./run-events.ts";

const DEFAULT_DWELL_MS = 500;

/**
 * The entry to show, from the one shown so far (`-1`: none yet) and the queue's last index: none
 * while the queue is empty, the last of the first batch, else the one shown, clamped to the queue.
 */
export function tickerIndex(index: number, lastIndex: number): number {
  if (lastIndex < 0) return -1;
  return index < 0 ? lastIndex : Math.min(index, lastIndex);
}

/**
 * @param entries the ascending visible-log queue (`visibleLogEntries(logs)`).
 * @param dwellMs minimum on-screen time per entry before advancing (default 500).
 * @returns the entry currently due for display, or `undefined` while empty.
 */
export function useLogTicker(
  entries: readonly VisibleLogEntry[],
  dwellMs: number = DEFAULT_DWELL_MS,
): VisibleLogEntry | undefined {
  const [index, setIndex] = useState(-1);
  const lastIndex = entries.length - 1;
  const shown = tickerIndex(index, lastIndex);
  if (shown !== index) setIndex(shown);

  useEffect(() => {
    if (shown >= lastIndex) return;
    const timer = setTimeout(() => setIndex(shown + 1), dwellMs);
    return () => clearTimeout(timer);
  }, [shown, lastIndex, dwellMs]);

  return shown < 0 ? undefined : entries[shown];
}
