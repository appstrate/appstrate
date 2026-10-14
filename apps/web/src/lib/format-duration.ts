// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";

function unit(value: number, unit: string, fractionDigits = 0): string {
  return new Intl.NumberFormat(i18n.language, {
    style: "unit",
    unit,
    unitDisplay: "short",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * An elapsed duration (milliseconds) in the interface's language: « 842 ms »,
 * « 4,8 s », « 5 min 12 s ». The ranges are `formatDuration`'s
 * (`@appstrate/core/format`, the CLI's), only the writing follows the locale.
 * `NaN`, infinities and negatives read as zero rather than a misleading figure.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return unit(0, "millisecond");
  if (ms < 1000) return unit(Math.round(ms), "millisecond");
  const seconds = ms / 1000;
  if (seconds < 60) return unit(seconds, "second", 1);
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${unit(minutes, "minute")} ${unit(rest, "second")}`;
}
