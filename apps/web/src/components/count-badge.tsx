// SPDX-License-Identifier: Apache-2.0

import { cn } from "@appstrate/ui/cn";

const TONE = {
  destructive: "bg-destructive text-destructive-foreground",
  primary: "bg-primary text-primary-foreground",
  spark: "bg-spark text-spark-foreground",
} as const;

/**
 * A small count bubble (unread runs, pending shares, notifications), capped at
 * « 99+ ». Nothing at zero, so a caller never guards it. `label` is what a
 * screen reader hears instead of the bare number.
 */
export function CountBadge({
  count,
  label,
  tone = "destructive",
  className,
}: {
  count: number;
  label: string;
  tone?: keyof typeof TONE;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium",
        TONE[tone],
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
