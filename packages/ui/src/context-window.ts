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
 * A token count as the compact figure the gauge shows, in the UI language (`128K` / `1.5M` in
 * English, `128 k` / `1,5 M` in French — a no-break space, as `Intl` puts it). The tier is chosen
 * by `Intl` after rounding, so `999_600` is `1M`, not `1000K`.
 */
export function formatCompactTokens(tokens: number, lang: string): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  return formatter(COMPACT, lang, { notation: "compact" }).format(tokens);
}

/**
 * A count as {@link formatCompactTokens} does, marked `≈` when it is approximate: a fallback
 * window, not a declared one, or a measure read against another model than the one that took it.
 */
export function formatTokenFigure(
  tokens: number,
  approximate: boolean | undefined,
  lang: string,
): string {
  const figure = formatCompactTokens(tokens, lang);
  return approximate ? `≈\u00a0${figure}` : figure;
}

/** A 0..1 share as a localized percentage (`Intl`: French puts a narrow no-break space before the sign). */
export function formatWindowPercent(fraction: number, lang: string): string {
  return formatter(PERCENT, lang, { style: "percent", maximumFractionDigits: 0 }).format(fraction);
}

/** One formatter per language and style: gauges format on every render. */
const COMPACT = new Map<string, Intl.NumberFormat>();
const PERCENT = new Map<string, Intl.NumberFormat>();

function formatter(
  cache: Map<string, Intl.NumberFormat>,
  lang: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  let format = cache.get(lang);
  if (!format) {
    format = new Intl.NumberFormat(lang, options);
    cache.set(lang, format);
  }
  return format;
}
