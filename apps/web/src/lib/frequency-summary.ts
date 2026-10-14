// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule's frequency said as a sentence (« Tous les jours à 3:00 »), in the
 * interface's language. The composer reads back what is being composed with it,
 * and every list and overview says a stored schedule with it, so a schedule reads
 * the same wherever it appears.
 *
 * The times in the sentence are wall-clock times in the schedule's own zone (the
 * scheduler evaluates the expression there): whoever shows the sentence shows the
 * zone with it.
 */

import i18n from "../i18n";
import { type Frequency, type TimeOfDay, WEEK_ORDER, parseCron } from "./cron-frequency";

/** The Intl formatters the sentence and the composer share. */
export function frequencyFormats(lang: string = i18n.language) {
  // The time of day as written, in no zone: formatting it in UTC keeps it as is.
  const time = (at: TimeOfDay) =>
    new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
      Date.UTC(2000, 0, 1, at.hour, at.minute),
    );
  // 7 January 2024 was a Sunday: cron weekday d is that date plus d days.
  const weekday = (day: number, width: "long" | "short") =>
    new Intl.DateTimeFormat(lang, { weekday: width, timeZone: "UTC" }).format(
      Date.UTC(2024, 0, 7 + day),
    );
  const list = (items: string[]) =>
    new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(items);
  return { time, weekday, list };
}

/**
 * The sentence for a composed frequency; `null` for a `custom` expression, which
 * has no sentence and is shown as itself. A weekly frequency with no day yet is
 * the composer's to word.
 */
export function describeFrequency(frequency: Frequency): string | null {
  const t = i18n.getFixedT(i18n.language, "agents");
  const format = frequencyFormats();
  switch (frequency.kind) {
    case "minutes":
      return t("schedule.frequency.summary.minutes", { count: frequency.every });
    case "hours":
      return t("schedule.frequency.summary.hours", {
        count: frequency.every,
        minute: String(frequency.minute).padStart(2, "0"),
      });
    case "daily":
      return t("schedule.frequency.summary.daily", { time: format.time(frequency.at) });
    case "weekly":
      return t("schedule.frequency.summary.weekly", {
        days: format.list(
          WEEK_ORDER.filter((d) => frequency.days.includes(d)).map((d) =>
            format.weekday(d, "long"),
          ),
        ),
        time: format.time(frequency.at),
      });
    case "monthly":
      return t(
        frequency.day === 1
          ? "schedule.frequency.summary.monthlyFirst"
          : "schedule.frequency.summary.monthly",
        { day: frequency.day, time: format.time(frequency.at) },
      );
    case "custom":
      return null;
  }
}

/**
 * A schedule's recurrence and the zone its times are in: « Tous les jours à 3:00 (UTC) ».
 * An expression with no sentence is said as itself (`isCron`), still with its zone.
 */
export function describeSchedule(schedule: { cron_expression: string; timezone: string }): {
  text: string;
  isCron: boolean;
} {
  const sentence = describeFrequency(parseCron(schedule.cron_expression));
  return {
    text: `${sentence ?? schedule.cron_expression} (${schedule.timezone})`,
    isCron: sentence === null,
  };
}
