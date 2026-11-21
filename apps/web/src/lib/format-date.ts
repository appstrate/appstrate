// SPDX-License-Identifier: Apache-2.0

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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How far `at` is from `now`, in the active i18n language: « dans 3 h »,
 * « il y a 5 min », « maintenant » under a minute. The count is truncated
 * toward zero, so a run 1 h 50 away reads « dans 1 h », never later than it
 * is. Days count elapsed 24-hour spans, not calendar days: « dans 1 j » is a
 * duration, which no zone can make wrong, where « demain » would depend on the
 * reader's midnight. Months are 30 days, years 365. Zone-free: the absolute
 * date next to it is the one that names a zone. An unparseable date → "—".
 */
export function formatRelativeDate(dateStr: string | Date | number, now: number): string {
  const at = dateStr instanceof Date ? dateStr.getTime() : new Date(dateStr).getTime();
  if (Number.isNaN(at)) return "—";
  const diff = at - now;
  const abs = Math.abs(diff);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < MINUTE
      ? [0, "second"]
      : abs < HOUR
        ? [diff / MINUTE, "minute"]
        : abs < DAY
          ? [diff / HOUR, "hour"]
          : abs < 30 * DAY
            ? [diff / DAY, "day"]
            : abs < 365 * DAY
              ? [diff / (30 * DAY), "month"]
              : [diff / (365 * DAY), "year"];
  const count = Math.trunc(value);
  try {
    // `auto` only for the zero: « maintenant », not « dans 0 seconde ».
    return new Intl.RelativeTimeFormat(i18n.language, {
      style: "short",
      numeric: count === 0 ? "auto" : "always",
    }).format(count, unit);
  } catch {
    return formatDateField(at);
  }
}

/**
 * How soon a scheduled run fires, as of `now`. A time already past reads
 * « maintenant »: the scheduler has not picked the run up yet, which is not
 * the missed run « il y a 2 min » would suggest.
 */
export function formatTimeUntil(dateStr: string | Date, now: number): string {
  const at = new Date(dateStr).getTime();
  return formatRelativeDate(Number.isNaN(at) ? dateStr : Math.max(at, now), now);
}

/** A scheduled run read both ways: « dans 3 h · 22/11/2026 09:00 UTC ». */
export function formatScheduledAt(
  dateStr: string | Date,
  timeZone: string | null | undefined,
  now: number,
): string {
  return `${formatTimeUntil(dateStr, now)} · ${formatDateField(dateStr, "datetime", timeZone)}`;
}
