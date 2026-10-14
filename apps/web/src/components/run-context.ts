// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind "how full was this run's context window, turn by turn".
 *
 * Its consumer is the per-turn table (`TurnsTable`, in `run-execution-tab.tsx`),
 * which draws each turn's context as a share of the model window. This module
 * decides which window applies and computes the share; the table only renders
 * what it returns.
 *
 * Split from the component for the same reason `run-cost.ts` is: the web test
 * runner has no DOM, and the arithmetic is the part worth testing.
 *
 * DENOMINATOR PROVENANCE — the window is read off the turns, not off the run
 * row. The runner is the authority on it (it applies the container-side default
 * the platform cannot see), and it states it on the same payload as the token
 * counts, so a run whose logs were pruned cannot keep a denominator with no
 * numerator left to divide.
 */

import type { RunTurnRow } from "./log-utils";

/**
 * A run's context window, as the turns state it. Returned only when there is
 * BOTH a usable numerator and a denominator — see {@link readRunContext} for why
 * the absence of either yields `null` rather than a zeroed reading.
 */
interface RunContextReading {
  /** The denominator: the window last stated by a turn — see {@link readRunContext}. */
  window: number;
}

/**
 * A token count as a 0..1 share of the window — the ONE percentage computation
 * in the SPA, used for every bar width and every `%` label.
 *
 * Clamped to `[0, 1]`: a bar cannot render past its track, and a `103 %` label
 * would read as a context overflow when the only realistic cause is a window
 * that no longer matches what the provider billed. The absolute token counts
 * are rendered next to every percentage, so the clamp hides no number the
 * reader does not already have.
 */
export function fractionOfWindow(tokens: number, window: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / window));
}

/**
 * Derive the context window for a run, or `null` when there is nothing
 * truthful to measure against. On `null` the table falls back to bars relative
 * to the run's own peak and drops its `%` column.
 *
 * Three independent null cases:
 *
 *  1. **No turns.** Runs predating the per-turn breadcrumb emit none, so there
 *     is nothing to measure.
 *
 *  2. **No window.** No turn states one: runs predating the field carry none,
 *     and a runner that cannot size the model it is driving omits it. The turns
 *     may still carry real token counts, but a raw count with no denominator
 *     says nothing about headroom — 128k is comfortable in a 1M window and
 *     terminal in a 200k one. Fabricating a 200k default client-side is
 *     rejected outright: the runner already applies its own default when it has
 *     one, so the absence of the field means genuinely unknown, not "assume
 *     Claude".
 *
 *  3. **No turn with a usable reading.** A turn can settle with
 *     `contextTokens === 0`: the runner emits the breadcrumb as soon as EITHER
 *     the input or the output delta is positive, and `contextTokens` is built
 *     from the input side only (input + cache read + cache write). A provider
 *     that reports completion tokens but omits the prompt count — openai-
 *     compatible gateways do — therefore produces a real turn whose context
 *     reads zero. That is a measurement gap, not an empty context, and a run in
 *     which every turn reads zero has measured nothing to put in a share.
 *
 * WHICH TURN'S WINDOW — the LAST turn that states a usable one.
 *
 * Every turn carries it, so on the ordinary run they all agree and the choice is
 * invisible. It becomes a decision on a run whose model was swapped mid-flight,
 * and "last" is the one that keeps the reading honest:
 *
 *   - The first window would size the run's latest turns against a model that
 *     is no longer running.
 *   - The max flatters the run in the one direction that matters: after a swap
 *     down from 1M to 200k, a 190k context would read 19 % while it is one turn
 *     from compaction.
 *   - Turns that state no window are skipped rather than treated as a reset: a
 *     runner that stops being able to size its model has not said the window
 *     shrank, so the last statement stands until a new one replaces it.
 *
 * On a swap down, earlier turns can exceed that single window. `fractionOfWindow`
 * clamps their bars and the raw counts are rendered unclamped beside them — the
 * same treatment as a window that disagrees with what the provider billed.
 */
export function readRunContext(turns: readonly RunTurnRow[] | undefined): RunContextReading | null {
  if (!turns || turns.length === 0) return null;

  // Walking the array as the runner emitted it, rather than sorting by `index`,
  // keeps this total: a malformed index cannot silently reorder the series.
  // Named `contextWindow`, not `window`: this file is bundled for the browser
  // and a local shadowing the global reads as a bug to the next person.
  let contextWindow: number | null = null;
  let measured = false;
  for (const turn of turns) {
    const stated = turn.contextWindow;
    if (typeof stated === "number" && Number.isFinite(stated) && stated > 0) {
      contextWindow = stated;
    }
    const tokens = turn.contextTokens;
    if (Number.isFinite(tokens) && tokens > 0) measured = true;
  }
  if (contextWindow == null || !measured) return null;

  return { window: contextWindow };
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
