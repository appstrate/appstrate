// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind "how full is this run's context window", shared by the Usage
 * gauge and the per-turn table so they always agree.
 *
 * `current` is the LAST turn's context (non-monotone: it drops on auto-compaction,
 * which is the signal); `peak` is the max across turns. Both only count turns with
 * a positive context, and the window is read off the turns, not the run row.
 */

import type { RunTurnRow } from "./log-utils";

/** Returned only when there is BOTH a numerator and a denominator, never a zeroed reading. */
interface RunContextReading {
  /** Context size of the last turn with a positive reading. */
  current: number;
  peak: number;
  /** The window last stated by a turn. */
  window: number;
  /** 0..1 shares of {@link window}. */
  currentFraction: number;
  peakFraction: number;
}

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
 * The context reading for a run, or `null` when there is nothing truthful to render (a
 * zeroed bar would claim an empty context): no turns, no turn stating a window (no
 * client-side default: absence means unknown), or no turn with a positive `contextTokens`
 * (providers omitting the prompt count settle at zero, a measurement gap, so those turns
 * are skipped and `current` is the last usable one).
 *
 * The window is the LAST one stated: the first would size `current` against a model no
 * longer running, the max would under-report after a swap down. `peak` shares it and may
 * exceed it; the bar is clamped.
 */
export function readRunContext(turns: readonly RunTurnRow[] | undefined): RunContextReading | null {
  if (!turns || turns.length === 0) return null;

  // Walk in emitted order rather than sorting by `index`: a malformed index cannot reorder the series.
  // Named `contextWindow`: a local `window` would shadow the global in this browser bundle.
  let contextWindow: number | null = null;
  let current = 0;
  let peak = 0;
  for (const turn of turns) {
    const stated = turn.contextWindow;
    if (typeof stated === "number" && Number.isFinite(stated) && stated > 0) {
      contextWindow = stated;
    }
    const tokens = turn.contextTokens;
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    current = tokens;
    peak = Math.max(peak, tokens);
  }
  if (contextWindow == null) return null;
  if (peak <= 0) return null;

  return {
    current,
    peak,
    window: contextWindow,
    currentFraction: fractionOfWindow(current, contextWindow),
    peakFraction: fractionOfWindow(peak, contextWindow),
  };
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
