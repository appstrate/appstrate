// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind "how full is this run's context window".
 *
 * Two surfaces read it — the run-header gauge (`ContextGaugeReadout`) and the
 * Info tab's per-turn table (`TurnsTable`) — and they must agree: a header
 * saying `64 %` above a table whose widest bar is always full is exactly the
 * disagreement #1046 exists to remove. This module is the single derivation;
 * the two components only render what it returns.
 *
 * Split from both components for the same reason `run-cost.ts` is: the web test
 * runner has no DOM, and the arithmetic is the part worth testing.
 *
 * NUMERATOR SEMANTICS — the two readings are deliberately different:
 *   - `current` is the LAST turn's context, not the max and not a sum. It is
 *     non-monotone: it drops when the runner auto-compacts, and that drop is
 *     the signal ("the run just bought itself headroom").
 *   - `peak` is the max across every turn — the post-mortem question, "did this
 *     run come close to compaction at any point".
 */

import type { RunTurnRow } from "./log-utils";

/**
 * Everything the two surfaces need about a run's context occupancy. Returned
 * only when there is BOTH a numerator and a denominator — see
 * {@link readRunContext} for why the absence of either yields `null` rather
 * than a zeroed reading.
 */
export interface RunContextReading {
  /** Context size of the last settled turn — the "where is it now" figure. */
  current: number;
  /** Largest context size across all turns — the post-mortem figure. */
  peak: number;
  /** The denominator: the context window the run launched with. */
  window: number;
  /** Auto-compaction trigger point, or `null` when the platform cannot know it. */
  threshold: number | null;
  /** {@link current} as a 0..1 share of {@link window}. */
  currentFraction: number;
  /** {@link peak} as a 0..1 share of {@link window}. */
  peakFraction: number;
  /** {@link threshold} as a 0..1 share of {@link window}, or `null`. */
  thresholdFraction: number | null;
}

/**
 * A token count as a 0..1 share of the window — the ONE percentage computation
 * in the SPA, used for every bar width and every `%` label.
 *
 * Clamped to `[0, 1]`: a bar cannot render past its track, and a `103 %` label
 * would read as a context overflow when the only realistic cause is a window
 * recorded at launch that no longer matches what the provider billed. The
 * absolute token counts are rendered next to every percentage, so the clamp
 * hides no number the reader does not already have.
 */
export function fractionOfWindow(tokens: number, window: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / window));
}

/**
 * Derive the context reading for a run, or `null` when there is nothing
 * truthful to render.
 *
 * Two independent null cases, both deliberately collapsing to "no gauge":
 *
 *  1. **No turns.** Runs predating the per-turn breadcrumb emit none, so there
 *     is no numerator at all. A zeroed bar would read as "the context is
 *     empty", which is a lie about a run that may have filled its window.
 *
 *  2. **No window.** `context_window` is `null` for runs created before the
 *     column existed and for remote-origin runs that resolved no platform
 *     model. This is the interesting case, because the turns may still carry a
 *     perfectly real `128 430`: we drop it anyway. A raw token count with no
 *     denominator informs nobody — 128k is comfortable in a 1M window and
 *     terminal in a 200k one, and the header's whole job is to answer "how much
 *     headroom is left" at a glance. Naming the cost of that choice: the number
 *     is not lost, it is relocated — the Info tab's per-turn table still lists
 *     every turn's absolute context, and falls back to its own peak-relative
 *     bar precisely so a window-less run keeps a readable breakdown somewhere.
 *     Fabricating a 200k denominator client-side is the one option rejected
 *     outright: the server already applies that fallback at launch for every
 *     run that has a window, so a `null` here means genuinely unknown.
 */
export function readRunContext(
  turns: readonly RunTurnRow[] | undefined,
  contextWindow: number | null | undefined,
  compactionThreshold: number | null | undefined,
): RunContextReading | null {
  if (!turns || turns.length === 0) return null;
  if (contextWindow == null || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  // `turns` is ordered as the runner emitted it, so the last element is the
  // most recent settled turn. Reading `at(-1)` rather than sorting by `index`
  // keeps this total: a malformed index cannot silently reorder the series.
  const current = turns[turns.length - 1]!.contextTokens;
  let peak = 0;
  for (const turn of turns) peak = Math.max(peak, turn.contextTokens);

  // The threshold is advisory and only meaningful inside the window — a value
  // at or past the window marks nothing a full bar does not already say.
  const threshold =
    compactionThreshold != null &&
    Number.isFinite(compactionThreshold) &&
    compactionThreshold > 0 &&
    compactionThreshold < contextWindow
      ? compactionThreshold
      : null;

  return {
    current,
    peak,
    window: contextWindow,
    threshold,
    currentFraction: fractionOfWindow(current, contextWindow),
    peakFraction: fractionOfWindow(peak, contextWindow),
    thresholdFraction: threshold == null ? null : fractionOfWindow(threshold, contextWindow),
  };
}

/**
 * A token count as the compact figure the gauge shows (`128k`, `1.0M`).
 *
 * Decimal thousands, not the binary tiers of `formatBytes` — these are counts,
 * not bytes, and `200000` must read `200k` and not `195K`. The `M` tier is not
 * speculative: 1M-token windows are shipping models, and `1000k / 1000k` would
 * be unreadable.
 */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * A 0..1 share as a localized percentage.
 *
 * `Intl` rather than a hand-built `${n} %`: French puts a narrow no-break space
 * before the sign and English puts none, and encoding that in a translation
 * string would make it a per-locale hazard instead of a formatting rule. The
 * caller passes `i18n.language` so this stays pure and testable.
 */
export function formatWindowPercent(fraction: number, lang: string): string {
  return new Intl.NumberFormat(lang, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
}
