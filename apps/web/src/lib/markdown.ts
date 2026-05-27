// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";

export type DateGranularity = "date" | "datetime";

/**
 * Centralized date formatter for the dashboard. Always uses the active i18n
 * language so all surfaces share one locale source.
 *
 * @param dateStr  Date, ISO string, or unix-ms number. null/undefined → em-dash.
 * @param granularity  "datetime" (default) renders date + hour:minute;
 *                     "date" renders date only.
 */
export function formatDateField(
  dateStr: string | Date | number | null | undefined,
  granularity: DateGranularity = "datetime",
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
    }
    return d.toLocaleString(i18n.language, options);
  } catch {
    return String(dateStr);
  }
}
