// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
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

/**
 * A labelled usage row: the name on the left, `summary` on the right, the gauge underneath
 * (omitted when `percent` is null — an unlimited quota). `loading` draws the skeleton of both.
 */
export function UsageMeter({
  label,
  summary,
  percent,
  loading = false,
  className,
}: {
  label: string;
  summary?: ReactNode;
  percent: number | null;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        {loading ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          <span className="font-medium">{summary}</span>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-2 w-full rounded-full" />
      ) : percent !== null ? (
        <UsageBar percent={percent} label={label} />
      ) : null}
    </div>
  );
}
