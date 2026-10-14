// SPDX-License-Identifier: Apache-2.0

import { cn } from "@appstrate/ui/cn";
import { getUsageBarColor } from "../lib/usage-severity";

/**
 * A usage gauge: a track filled to `percent` (clamped to 0-100) in the severity color of
 * `lib/usage-severity`. `label` names it for assistive tech; `className` restyles the track.
 */
export function UsageBar({
  percent,
  label,
  className,
}: {
  percent: number;
  label: string;
  className?: string;
}) {
  const value = Math.min(100, Math.max(0, percent));
  return (
    <div
      className={cn("bg-muted h-2 w-full overflow-hidden rounded-full", className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn("h-full rounded-full transition-all", getUsageBarColor(value))}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}
