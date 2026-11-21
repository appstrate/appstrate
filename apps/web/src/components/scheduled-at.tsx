// SPDX-License-Identifier: Apache-2.0

import { useNowTick } from "@appstrate/ui/use-now-tick";
import { formatDateField, formatScheduledAt, formatTimeUntil } from "../lib/format-date";

/**
 * When a scheduled run fires: `full` reads « dans 3 h · 22/11/2026 09:00 UTC »,
 * `relative` reads « dans 3 h » with the date on hover, for narrow places.
 */
export function ScheduledAt({
  at,
  timeZone,
  variant = "full",
}: {
  /** ISO 8601, as the API sends `next_run_at`. */
  at: string;
  /** The schedule's zone, named next to the date. */
  timeZone: string;
  variant?: "full" | "relative";
}) {
  const now = useNowTick();
  return variant === "relative" ? (
    <time dateTime={at} title={formatDateField(at, "datetime", timeZone)}>
      {formatTimeUntil(at, now)}
    </time>
  ) : (
    <time dateTime={at}>{formatScheduledAt(at, timeZone, now)}</time>
  );
}
