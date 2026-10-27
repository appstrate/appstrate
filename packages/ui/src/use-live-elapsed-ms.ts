// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

/**
 * Live execution time. Returns the milliseconds since `startedAt`, re-rendering
 * 5×/s while `endedAt` is absent and freezing at `endedAt - startedAt` once it
 * is set. `undefined` until `startedAt` is a valid date, so the caller can omit
 * the figure rather than show `0`. The clock advances only from the interval
 * callback, never the effect body.
 */
export function useLiveElapsedMs(
  startedAt: string | null | undefined,
  endedAt?: string | null,
): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!startedAt && !endedAt;

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [ticking]);

  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = endedAt ? Date.parse(endedAt) : now;
  return Number.isNaN(end) ? undefined : Math.max(0, end - start);
}
