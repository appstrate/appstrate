// SPDX-License-Identifier: Apache-2.0

/**
 * Paces the run card's single-line log display. Logs can arrive in bursts (an
 * agent emits several lines in one tick), which would flash through the card
 * faster than the eye can read. This hook walks the visible-log queue one entry
 * at a time, holding each for at least `dwellMs` before advancing, so a burst
 * plays back as a readable sequence instead of an instant jump to the last line.
 *
 * It never drops entries and never runs ahead of the data: when the displayed
 * index has caught up to the newest entry it simply idles until more arrive. The
 * very first entry shows immediately (no artificial delay before anything is on
 * screen); only subsequent advances are rate-limited.
 *
 * `setIndex` is only ever called from the `setTimeout` callback — never the
 * effect body — keeping the React static-rules gate (`set-state-in-effect`)
 * happy, same as the SSE callbacks in `use-run-log-stream.ts`.
 */

import { useEffect, useState } from "react";
import type { VisibleLogEntry } from "./run-events.ts";

const DEFAULT_DWELL_MS = 500;

/**
 * @param entries the ascending visible-log queue (`visibleLogEntries(logs)`).
 * @param dwellMs minimum on-screen time per entry before advancing (default 500).
 * @returns the entry currently due for display, or `undefined` while empty.
 */
export function useLogTicker(
  entries: readonly VisibleLogEntry[],
  dwellMs: number = DEFAULT_DWELL_MS,
): VisibleLogEntry | undefined {
  const [index, setIndex] = useState(0);
  const lastIndex = entries.length - 1;

  useEffect(() => {
    // Caught up to (or past) the newest entry: nothing to advance to yet.
    if (index >= lastIndex) return;
    const timer = setTimeout(() => {
      setIndex((i) => i + 1);
    }, dwellMs);
    return () => clearTimeout(timer);
  }, [index, lastIndex, dwellMs]);

  if (entries.length === 0) return undefined;
  // Clamp: the queue only grows in practice, but a reset (new run id remounts
  // the panel) or any shrink must never index out of bounds.
  return entries[Math.min(index, lastIndex)];
}
