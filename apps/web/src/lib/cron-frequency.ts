// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule's frequency as a person composes it, and the cron expression the
 * server stores. The composer edits a `Frequency`; the wire carries cron.
 *
 * Every shape below maps to ONE five-field cron expression and back, so an
 * expression written by the composer always reopens in it. Anything else (a
 * range of hours, two minutes, a month list) stays `custom`: the raw
 * expression, still previewed, never rewritten behind its author's back.
 */

import { CronExpressionParser } from "cron-parser";

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export type Frequency =
  | { kind: "minutes"; every: number }
  | { kind: "hours"; every: number; minute: number }
  | { kind: "daily"; at: TimeOfDay }
  | { kind: "weekly"; days: number[]; at: TimeOfDay }
  | { kind: "monthly"; day: number; at: TimeOfDay }
  | { kind: "custom"; cron: string };

export type FrequencyKind = Frequency["kind"];

/** Cron weekdays (0 = Sunday), in the order a French week reads them. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const NUMBER = /^\d+$/;

function int(field: string, min: number, max: number): number | null {
  if (!NUMBER.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** `*` (every unit, i.e. 1) or `*\/N`. */
function step(field: string, max: number): number | null {
  if (field === "*") return 1;
  const match = /^\*\/(\d+)$/.exec(field);
  return match ? int(match[1]!, 1, max) : null;
}

/** A weekday field: single days, lists and ranges (`1-5`), 7 read as Sunday. */
function weekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const from = int(range[1]!, 0, 7);
      const to = int(range[2]!, 0, 7);
      if (from === null || to === null || from > to) return null;
      for (let day = from; day <= to; day++) days.add(day % 7);
      continue;
    }
    const day = int(part, 0, 7);
    if (day === null) return null;
    days.add(day % 7);
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/** The composer's reading of an expression; `custom` when no shape matches it. */
export function parseCron(cron: string): Frequency {
  const custom: Frequency = { kind: "custom", cron };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return custom;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== "*") return custom;

  if (hour === "*" && dom === "*" && dow === "*") {
    const every = step(min, 59);
    if (every !== null) return { kind: "minutes", every };
  }
  const minute = int(min, 0, 59);
  if (minute === null) return custom;
  if (dom === "*" && dow === "*") {
    const every = step(hour, 23);
    if (every !== null) return { kind: "hours", every, minute };
  }
  const h = int(hour, 0, 23);
  if (h === null) return custom;
  const at = { hour: h, minute };
  if (dom === "*" && dow === "*") return { kind: "daily", at };
  if (dom === "*") {
    const days = weekdays(dow);
    if (!days) return custom;
    return days.length === 7 ? { kind: "daily", at } : { kind: "weekly", days, at };
  }
  if (dow === "*") {
    const day = int(dom, 1, 31);
    if (day !== null) return { kind: "monthly", day, at };
  }
  return custom;
}

/** The expression a frequency stores. */
export function toCron(frequency: Frequency): string {
  switch (frequency.kind) {
    case "minutes":
      return frequency.every === 1 ? "* * * * *" : `*/${frequency.every} * * * *`;
    case "hours":
      return `${frequency.minute} ${frequency.every === 1 ? "*" : `*/${frequency.every}`} * * *`;
    case "daily":
      return `${frequency.at.minute} ${frequency.at.hour} * * *`;
    case "weekly":
      return `${frequency.at.minute} ${frequency.at.hour} * * ${[...frequency.days]
        .sort((a, b) => a - b)
        .join(",")}`;
    case "monthly":
      return `${frequency.at.minute} ${frequency.at.hour} ${frequency.day} * *`;
    case "custom":
      return frequency.cron.trim();
  }
}

/**
 * The next `count` fires of `cron` in `timezone`, by the parser the scheduler
 * itself uses; `null` when the expression does not parse.
 */
export function nextFires(
  cron: string,
  timezone: string,
  count = 3,
  from = new Date(),
): Date[] | null {
  try {
    const interval = CronExpressionParser.parse(cron, { tz: timezone, currentDate: from });
    return Array.from({ length: count }, () => interval.next().toDate());
  } catch {
    return null;
  }
}

/** The zone a new schedule starts in: the browser's, the one its author lives in. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
