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
