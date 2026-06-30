// SPDX-License-Identifier: Apache-2.0

/**
 * Live execution-time ticker for the run card. Given the run's `startedAt` (and
 * `completedAt` once terminal), returns the elapsed milliseconds, re-rendering
 * every second while the run is in flight and freezing at the final duration
 * once it completes.
 *
 * Returns `undefined` until `startedAt` is known (e.g. a run_and_wait still
 * blocking before its first `run_update`), so the caller can omit the time
 * rather than show `0s`.
 *
 * The clock advances only from the `setInterval` callback — never the effect
 * body — keeping the React static-rules gate happy.
 */

import { useEffect, useState } from "react";

export function useLiveElapsedMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!startedAt && !completedAt;

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = completedAt ? Date.parse(completedAt) : now;
  return Math.max(0, end - start);
}
