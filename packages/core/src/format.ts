// SPDX-License-Identifier: Apache-2.0

/**
 * Human-readable formatters used across the platform's CLI, web UI,
 * runtime prompt builder, and the `@appstrate/ui` schema-form widgets.
 *
 * These helpers exist to retire four near-identical inline copies of
 * `formatBytes` that drifted on edge cases (negative input, GB tier,
 * fractional precision). Centralizing them gives one tested
 * implementation and one place to evolve.
 */

/** Unit names per tier. French counts in octets; every other language keeps the IEC-less English spelling. */
const BYTE_UNITS = {
  en: ["B", "KB", "MB", "GB"],
  fr: ["o", "Ko", "Mo", "Go"],
} as const;

/**
 * Format a byte count as a compact human string (B / KB / MB / GB).
 *
 * Defensive against `NaN`, `Infinity`, and negative values — those fall
 * back to `"<n> B"` so callers never see a misleading positive
 * megabyte/gigabyte figure for malformed input.
 *
 * Tier breakpoints are powers of 1024 (binary). Precision rule
 * (matches CLI prior art the audit consolidated): values ≥ 10 in their
 * tier are rounded to an integer (e.g. `12 KB`); values < 10 carry one
 * decimal (e.g. `2.0 KB`, `5.2 MB`).
 *
 * `locale` (a BCP 47 tag, e.g. the UI language) localises the unit names and
 * the decimal separator: `fr` renders `2,0 Ko`. Omitted — the CLI, logs, the
 * prompt builder — the output is the English form (`2.0 KB`). So is it for a
 * malformed tag (`fr_FR`): a display helper never throws.
 */
export function formatBytes(bytes: number, locale?: string): string {
  const tag = canonicalLocale(locale);
  const units = tag?.toLowerCase().startsWith("fr") ? BYTE_UNITS.fr : BYTE_UNITS.en;
  if (!Number.isFinite(bytes) || bytes < 0 || bytes < 1024) return `${bytes} ${units[0]}`;
  let value = bytes / 1024;
  let tier = 1;
  while (value >= 1024 && tier < units.length - 1) {
    value /= 1024;
    tier++;
  }
  const digits = value >= 10 ? 0 : 1;
  const amount = new Intl.NumberFormat(tag ?? "en", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(value);
  return `${amount} ${units[tier]}`;
}

/** The canonical form of a BCP 47 tag, or `undefined` when it is absent or malformed. */
function canonicalLocale(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

/**
 * Format an elapsed duration (milliseconds) as a compact human string:
 * sub-second as `<n>ms`, under a minute as one-decimal seconds (`2.6s`), and
 * longer as `<m>m <s>s`. This is the canonical run-duration format — the run
 * detail page, the run list row, and the in-chat run card all use it.
 *
 * Defensive against `NaN`/`Infinity`/negatives: those clamp to `0ms` so a
 * malformed input never shows a misleading figure.
 */
export function formatDuration(ms: number, locale?: string): string {
  const unit = (value: number, name: "millisecond" | "second" | "minute", digits = 0) => {
    if (!locale) {
      const suffix = { millisecond: "ms", second: "s", minute: "m" }[name];
      return `${value.toFixed(digits)}${suffix}`;
    }
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  };
  if (!Number.isFinite(ms) || ms < 0) return unit(0, "millisecond");
  if (ms < 1000) return unit(Math.round(ms), "millisecond");
  const seconds = ms / 1000;
  if (seconds < 60) return unit(seconds, "second", 1);
  const minutes = Math.floor(seconds / 60);
  return `${unit(minutes, "minute")} ${unit(Math.round(seconds - minutes * 60), "second")}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The span from `now` to `at` (epoch ms) in the coarsest unit that fits:
 * seconds under a minute (count 0), then minutes, hours, days under 30,
 * months of 30 days under 365 days, years. The count is signed (negative in
 * the past) and truncated toward zero, so a run 1 h 50 away is never
 * announced later than it is. Days are 24-hour spans, not calendar days: no
 * reader's midnight can make « dans 1 j » wrong, where « demain » could.
 */
function relativeSpan(
  at: number,
  now: number,
): [number, "second" | "minute" | "hour" | "day" | "month" | "year"] {
  const diff = at - now;
  const abs = Math.abs(diff);
  const [value, unit] =
    abs < MINUTE_MS
      ? ([0, "second"] as const)
      : abs < HOUR_MS
        ? ([diff / MINUTE_MS, "minute"] as const)
        : abs < DAY_MS
          ? ([diff / HOUR_MS, "hour"] as const)
          : abs < 30 * DAY_MS
            ? ([diff / DAY_MS, "day"] as const)
            : abs < 365 * DAY_MS
              ? ([diff / (30 * DAY_MS), "month"] as const)
              : ([diff / (365 * DAY_MS), "year"] as const);
  // `+ 0` turns -0 into 0, so a past instant under a minute is « maintenant », not « -0 ».
  return [Math.trunc(value) + 0, unit];
}

/**
 * `at` relative to `now`, both epoch milliseconds, as a phrase: « dans 3 h »,
 * « il y a 5 min », « maintenant » under a minute (`Intl.RelativeTimeFormat`).
 * `locale` as for {@link formatBytes}: omitted or malformed, English. Like it,
 * a display helper never throws: a non-finite `at` (an unparseable date)
 * renders "".
 */
export function formatRelativeTime(
  at: number,
  now: number,
  locale?: string,
  style: Intl.RelativeTimeFormatStyle = "short",
): string {
  if (!Number.isFinite(at)) return "";
  const [count, unit] = relativeSpan(at, now);
  // `auto` only for zero: « maintenant », not « dans 0 seconde ».
  return new Intl.RelativeTimeFormat(canonicalLocale(locale) ?? "en", {
    style,
    numeric: count === 0 ? "auto" : "always",
  }).format(count, unit);
}

/**
 * How old `at` is as of `now`, both epoch milliseconds, as a bare quantity for
 * a narrow column (« 5 min », « 3 h », « 2 j »), « maintenant » under a minute.
 * Same units, locale and "" for a non-finite `at` as {@link formatRelativeTime},
 * without its « il y a ».
 */
export function formatAge(at: number, now: number, locale?: string): string {
  if (!Number.isFinite(at)) return "";
  const [count, unit] = relativeSpan(at, now);
  const tag = canonicalLocale(locale) ?? "en";
  if (count === 0) return new Intl.RelativeTimeFormat(tag, { numeric: "auto" }).format(0, unit);
  return new Intl.NumberFormat(tag, { style: "unit", unit, unitDisplay: "short" }).format(
    Math.abs(count),
  );
}
