// SPDX-License-Identifier: Apache-2.0

import { useNowTick } from "../hooks/use-now-tick";
import { formatDateField, formatScheduledAt, formatTimeUntil } from "../lib/format-date";

/**
 * When a scheduled run fires, read two ways: how soon and the date itself, in
 * the schedule's own zone. `full`: « dans 3 h · 22/11/2026 09:00 UTC ».
 * `relative`: « dans 3 h », the date on hover — for the places too narrow for
 * both (the dashboard). The label moves on its own as time passes.
 */
export function ScheduledAt({
  at,
  timeZone,
  variant = "full",
}: {
  at: string | Date;
  /** The schedule's zone, named next to the date. */
  timeZone?: string | null;
  variant?: "full" | "relative";
}) {
  const now = useNowTick();
  const date = new Date(at);
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  return variant === "relative" ? (
    <time dateTime={iso} title={formatDateField(at, "datetime", timeZone)}>
      {formatTimeUntil(at, now)}
    </time>
  ) : (
    <time dateTime={iso}>{formatScheduledAt(at, timeZone, now)}</time>
  );
}
