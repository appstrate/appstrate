// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Reads back a native date / datetime-local value in full, so a truncated year
// typed segment by segment (`26` → `0026`) or swapped fields show at a glance.

const DATE = /^(\d{4,6})-(\d{2})-(\d{2})$/;
// No zone designator: a `Z` or an offset would make the local reading wrong, so it gets no echo.
const DATE_TIME = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

export interface DateEcho {
  /** Weekday, day, month name and full year (plus time for a date-time), in the UI locale. */
  text: string;
  /** The year as typed, zero-padded to four digits. */
  year: string;
  /** Years below 1000 are the signature of a truncated year, not a business rule. */
  unusualYear: boolean;
}

export function describeDateValue(
  value: unknown,
  kind: "date" | "date-time",
  locale?: string,
): DateEcho | null {
  if (typeof value !== "string") return null;
  const match = (kind === "date" ? DATE : DATE_TIME).exec(value);
  if (!match) return null;
  const [year, month, day, hour = 0, minute = 0] = match.slice(1).map(Number);

  // `Date.UTC` maps years 0-99 to 1900-1999; `setFullYear` does not.
  const date = new Date(0);
  if (kind === "date") date.setUTCFullYear(year!, month! - 1, day!);
  else {
    date.setFullYear(year!, month! - 1, day!);
    date.setHours(hour, minute, 0, 0);
  }
  const roundTrip =
    kind === "date"
      ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
      : [
          date.getFullYear(),
          date.getMonth() + 1,
          date.getDate(),
          date.getHours(),
          date.getMinutes(),
        ];
  if (roundTrip.some((part, i) => part !== [year, month, day, hour, minute][i])) return null;

  const text = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    // A calendar date has no zone: format it in UTC so no offset shifts the day.
    ...(kind === "date" ? { timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit" }),
  }).format(date);

  return { text, year: String(year).padStart(4, "0"), unusualYear: year! < 1000 };
}
