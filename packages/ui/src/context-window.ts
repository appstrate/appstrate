// SPDX-License-Identifier: Apache-2.0

/**
 * How full a model's context window is: a clamped share and compact token counts, shared by the
 * run gauge (`apps/web`) and the chat's composer gauge (`module-chat`).
 */

/**
 * A token count as a 0..1 share of the window — the ONE percentage computation
 * in the SPA. Clamped to `[0, 1]`: a bar cannot overflow its track, and the raw
 * counts are rendered unclamped beside every percentage.
 */
export function fractionOfWindow(tokens: number, window: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / window));
}

/**
 * A token count as the compact figure the gauge shows (`128k`, `1.0M`).
 * Decimal thousands (not `formatBytes` tiers). The tier is chosen AFTER rounding,
 * so `999_600` becomes `1.0M` rather than `1000k`.
 */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${thousands}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** A 0..1 share as a localized percentage (`Intl`: French puts a narrow no-break space before the sign). */
export function formatWindowPercent(fraction: number, lang: string): string {
  return new Intl.NumberFormat(lang, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
}
