// SPDX-License-Identifier: Apache-2.0

/**
 * How long a run took, live or frozen.
 *
 * Its own file because several surfaces need it — the run table and cards, the
 * dashboard, the run-detail header and its overview — and because of what the
 * live variant is: a LEAF. An interval in the row itself would re-render badges, trigger, links
 * and popover five times a second, per running run on screen. Here the state
 * that changes is owned by the only node that shows it, and a tick re-renders
 * one `<span>`.
 *
 * The formatting is `lib/format-duration`, so a run reads the same here as in
 * its log — in the interface's language, and a five-minute run reads
 * « 5 min 12 s » rather than « 312,0 s ».
 */

import { ACTIVE_RUN_STATUSES } from "@appstrate/shared-types";
import { formatDuration } from "../lib/format-duration";
import { cn } from "@appstrate/ui/cn";
import { useLiveElapsedMs } from "@appstrate/ui/use-live-elapsed-ms";

/** The statuses that mean "still going" are owned by the wire contract. */
const ACTIVE = ACTIVE_RUN_STATUSES as ReadonlySet<string>;

function ElapsedDuration({ startedAt, className }: { startedAt: string; className?: string }) {
  const elapsed = useLiveElapsedMs(startedAt);
  // A run that has not measurably started yet renders nothing rather than a
  // flickering `0.0s`.
  if (!elapsed) return null;
  return (
    <span className={cn("text-muted-foreground text-xs tabular-nums", className)}>
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
    <span className={cn("text-muted-foreground text-xs tabular-nums", className)}>
      {formatDuration(duration)}
    </span>
  );
}
