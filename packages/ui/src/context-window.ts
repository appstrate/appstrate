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
 * A token count as the compact figure the gauge shows, in the UI language (`128k` / `1.5M` in
 * English, `128 k` / `1,5 M` in French — a no-break space, as `Intl` puts it). The tier is chosen
 * by `Intl` after rounding, so `999_600` is `1M`, not `1000k`.
 */
export function formatCompactTokens(tokens: number, lang: string): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  return new Intl.NumberFormat(lang, { notation: "compact" }).format(tokens);
}

/** A window as {@link formatCompactTokens} does, marked `≈` when it is a fallback, not a declared size. */
export function formatContextWindow(window: number, assumed: boolean, lang: string): string {
  const figure = formatCompactTokens(window, lang);
  return assumed ? `≈\u00a0${figure}` : figure;
}

/** A 0..1 share as a localized percentage (`Intl`: French puts a narrow no-break space before the sign). */
export function formatWindowPercent(fraction: number, lang: string): string {
  return new Intl.NumberFormat(lang, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
}
