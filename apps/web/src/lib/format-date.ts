// SPDX-License-Identifier: Apache-2.0

import { formatRelativeTime as formatRelativeTimeIn } from "@appstrate/core/format";
import i18n from "../i18n";

type DateGranularity = "date" | "datetime";

/**
 * Uses the active i18n language. null/undefined → em-dash.
 * `timeZone`: an IANA zone, read in and named next to the time (« 15/10/2026 03:00 UTC »);
 * without it, the browser's zone, unnamed.
 */
export function formatDateField(
  dateStr: string | Date | number | null | undefined,
  granularity: DateGranularity = "datetime",
  timeZone?: string | null,
): string {
  if (dateStr === null || dateStr === undefined) return "—";
  try {
    const d = dateStr instanceof Date ? dateStr : new Date(dateStr);
    if (Number.isNaN(d.getTime())) return String(dateStr);
    const options: Intl.DateTimeFormatOptions = {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    };
    if (granularity === "datetime") {
      options.hour = "2-digit";
      options.minute = "2-digit";
      if (timeZone) {
        options.timeZone = timeZone;
        options.timeZoneName = "short";
      }
    }
    return d.toLocaleString(i18n.language, options);
  } catch {
    return String(dateStr);
  }
}

/** `formatRelativeTime` of `@appstrate/core/format` on an ISO date, in the interface's language. */
export function formatRelativeTime(
  at: string,
  now: number,
  style?: Intl.RelativeTimeFormatStyle,
): string {
  return formatRelativeTimeIn(Date.parse(at), now, i18n.language, style);
}

/**
 * How soon a scheduled run fires. A time already past reads « maintenant »:
 * the scheduler has not picked the run up yet, not missed it.
 */
export function formatTimeUntil(at: string, now: number): string {
  return formatRelativeTimeIn(Math.max(Date.parse(at), now), now, i18n.language);
}

/** A scheduled run read both ways: « dans 3 h · 22/11/2026 09:00 UTC ». */
export function formatScheduledAt(at: string, timeZone: string, now: number): string {
  return `${formatTimeUntil(at, now)} · ${formatDateField(at, "datetime", timeZone)}`;
}
