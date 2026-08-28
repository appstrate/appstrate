// SPDX-License-Identifier: Apache-2.0

/**
 * How long a run took, live or frozen.
 *
 * Its own file because two surfaces need it — the run table and the row pinned
 * under the run-detail header — and because of what the live variant is: a
 * LEAF. The interval used to live in the row itself, so every tick re-rendered
 * badges, trigger, links and popover ten times a second, per running run on
 * screen. Here the state that changes is owned by the only node that shows it,
 * and a tick re-renders one `<span>`.
 *
 * The formatting itself is the platform's (`@appstrate/core/format`), so a run
 * reads the same here as in its Info tab — and a five-minute run reads
 * "5m 12s" rather than the "312.0s" this file used to print.
 */

import { useState, useEffect } from "react";
import { ACTIVE_RUN_STATUSES } from "@appstrate/shared-types";
import { formatDuration } from "@appstrate/core/format";
import { cn } from "@appstrate/ui/cn";

/** The statuses that mean "still going" are owned by the wire contract. */
const ACTIVE = ACTIVE_RUN_STATUSES as ReadonlySet<string>;

export function ElapsedDuration({
  startedAt,
  className,
}: {
  startedAt: string;
  className?: string;
}) {
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(startedAt).getTime());

  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [startedAt]);

  // A run that has not measurably started yet renders nothing rather than a
  // flickering `0.0s`.
  if (!elapsed) return null;
  return (
    <span className={cn("text-muted-foreground font-mono text-xs", className)}>
      {formatDuration(elapsed)}
    </span>
  );
}

/**
 * The duration column: the live figure while the run is going, the frozen one
 * once it is over, nothing when neither exists. Never a timer on a terminal
 * run — a stale `duration` must not win over live time, nor the reverse.
 */
export function RunDuration({
  status,
  startedAt,
  duration,
  className,
}: {
  status: string;
  startedAt: string | null;
  duration: number | null;
  className?: string;
}) {
  if (ACTIVE.has(status) && startedAt != null) {
    return <ElapsedDuration startedAt={startedAt} className={className} />;
  }
  if (!duration) return null;
  return (
    <span className={cn("text-muted-foreground font-mono text-xs", className)}>
      {formatDuration(duration)}
    </span>
  );
}
