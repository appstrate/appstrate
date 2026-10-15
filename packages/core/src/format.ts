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
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rest}s`;
}

/** The coarsest unit a timestamp's age rounds down to; `now` is under a minute. */
export type RelativeAgeUnit = "now" | "minute" | "hour" | "day" | "month" | "year";

/**
 * How long ago an ISO timestamp was, as of `now` (epoch ms), in the coarsest
 * unit that fits: minutes under an hour, hours under a day, days under 30,
 * months (30 days) under 12, then years. Each level rounds the level below, so
 * 90 s reads as 2 minutes. `null` for an unparseable timestamp. The count is
 * clamped at 0, so a clock-skewed future timestamp reads as `now`. Language is
 * the caller's: it maps the unit to its own wording.
 */
export function relativeAge(
  iso: string,
  now: number,
): { unit: RelativeAgeUnit; count: number } | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return { unit: "now", count: 0 };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { unit: "minute", count: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { unit: "hour", count: hours };
  const days = Math.round(hours / 24);
  if (days < 30) return { unit: "day", count: days };
  const months = Math.round(days / 30);
  if (months < 12) return { unit: "month", count: months };
  return { unit: "year", count: Math.round(days / 365) };
}
