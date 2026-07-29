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
 *
 * Both readings are taken over the turns carrying a POSITIVE context only — see
 * {@link readRunContext} for the provider behaviour that makes a settled turn
 * report zero, and for the semantic refinement that exclusion implies.
 *
 * DENOMINATOR PROVENANCE — the window is read off the turns too, not off the run
 * row. The runner is the authority on it (it applies the container-side default
 * the platform cannot see), it states it where it already states the numerator,
 * and keeping the two on one payload removes the failure this module used to
 * have: a run whose logs were pruned kept a denominator with no numerator left
 * to divide.
 */

import type { RunTurnRow } from "./log-utils";

/**
 * Everything the two surfaces need about a run's context occupancy. Returned
 * only when there is BOTH a numerator and a denominator — see
 * {@link readRunContext} for why the absence of either yields `null` rather
 * than a zeroed reading.
 */
export interface RunContextReading {
  /**
   * Context size of the last turn that reported a usable (positive) reading —
   * the "where is it now" figure. Not simply "the last turn": see
   * {@link readRunContext}.
   */
  current: number;
  /** Largest context size across the turns with a usable reading. */
  peak: number;
  /** The denominator: the window last stated by a turn — see {@link readRunContext}. */
  window: number;
  /** {@link current} as a 0..1 share of {@link window}. */
  currentFraction: number;
  /** {@link peak} as a 0..1 share of {@link window}. */
  peakFraction: number;
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
 * Three independent null cases, all deliberately collapsing to "no gauge":
 *
 *  1. **No turns.** Runs predating the per-turn breadcrumb emit none, so there
 *     is no numerator at all. A zeroed bar would read as "the context is
 *     empty", which is a lie about a run that may have filled its window.
 *
 *  2. **No window.** No turn states one: runs predating the field carry none,
 *     and a runner that cannot size the model it is driving omits it. This is
 *     the interesting case, because the turns may still carry a perfectly real
 *     `128 430`: we drop it anyway. A raw token count with no denominator
 *     informs nobody — 128k is comfortable in a 1M window and terminal in a
 *     200k one, and the header's whole job is to answer "how much headroom is
 *     left" at a glance. Naming the cost of that choice: the number is not
 *     lost, it is relocated — the Info tab's per-turn table still lists every
 *     turn's absolute context, and falls back to its own peak-relative bar
 *     precisely so a window-less run keeps a readable breakdown somewhere.
 *     Fabricating a 200k default client-side is the one option rejected
 *     outright: the runner already applies its own default when it has one, so
 *     the absence of the field means genuinely unknown, not "assume Claude".
 *
 *  3. **No turn with a usable reading.** A turn can settle with
 *     `contextTokens === 0`: the runner emits the breadcrumb as soon as EITHER
 *     the input or the output delta is positive, and `contextTokens` is built
 *     from the input side only (input + cache read + cache write). A provider
 *     that reports completion tokens but omits the prompt count — openai-
 *     compatible gateways do — therefore produces a real turn whose context
 *     reads zero. That is a measurement gap, not an empty context, so those
 *     turns are excluded from BOTH readings, and a run in which none survives
 *     yields `null` for the same reason case 1 does.
 *
 * SEMANTIC REFINEMENT, not a guard: excluding them changes `current` from "the
 * last turn" to "the last turn with a usable reading". On a run whose final
 * turn reports no prompt count the gauge now shows the previous turn's context
 * rather than `0 / 200k · 0 %` — slightly stale, but stale beats false, and the
 * alternative renders an empty bar on a run holding ~190k.
 *
 * WHICH TURN'S WINDOW — the LAST turn that states a usable one.
 *
 * Every turn carries it, so on the ordinary run they all agree and the choice is
 * invisible. It becomes a decision on a run whose model was swapped mid-flight,
 * and "last" is the one that keeps the reading honest:
 *
 *   - The headline reading is `current`, "how full is the context NOW", and it
 *     is taken from the end of the series. Dividing it by the FIRST window
 *     would size it against a model that is no longer running.
 *   - Taking the MAX flatters the run in the one direction that matters: after
 *     a swap down from 1M to 200k, a 190k context would read 19 % while it is
 *     one turn from compaction. The gauge exists to prevent exactly that
 *     under-reporting.
 *   - Turns that state no window are skipped rather than treated as a reset:
 *     a runner that stops being able to size its model has not told us the
 *     window shrank, so the last statement stands until a new one replaces it.
 *
 * `peak` shares that single denominator, and on a swap DOWN it can therefore
 * exceed it. That is deliberate and already-handled: `fractionOfWindow` clamps
 * the bar, the raw counts are rendered unclamped beside it, and it is the same
 * treatment as a window that simply disagrees with what the provider billed.
 * The alternative — a second denominator for the peak — would put two different
 * windows in one gauge with one `aria-valuemax`, which is unreadable.
 */
export function readRunContext(turns: readonly RunTurnRow[] | undefined): RunContextReading | null {
  if (!turns || turns.length === 0) return null;

  // `turns` is ordered as the runner emitted it, so the last usable element is
  // the most recent settled turn that measured anything. Walking the array
  // rather than sorting by `index` keeps this total: a malformed index cannot
  // silently reorder the series.
  // Named `contextWindow`, not `window`: this file is bundled for the browser
  // and a local shadowing the global reads as a bug to the next person.
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
 *
 * Decimal thousands, not the binary tiers of `formatBytes` — these are counts,
 * not bytes, and `200000` must read `200k` and not `195K`. The `M` tier is not
 * speculative: 1M-token windows are shipping models, and `1000k / 1000k` would
 * be unreadable.
 *
 * The tier is chosen AFTER rounding, not before. Testing the raw count first
 * lets `999_600` fall in the `k` tier and then round to the very `1000k` the
 * paragraph above rejects — and on a 1 048 576-token window it would print it
 * next to `1.0M`, two magnitudes side by side.
 */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${thousands}k`;
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
