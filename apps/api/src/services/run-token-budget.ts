// SPDX-License-Identifier: Apache-2.0

/**
 * Context-budget snapshot persisted on a run at launch (issue #1046).
 *
 * The dashboard's context gauge needs two numbers: the tokens currently in
 * context (the NUMERATOR — already reported per turn by the runner's
 * `appstrate.progress` breadcrumb as `data.contextTokens`) and the window the
 * run actually ran against (the DENOMINATOR — this module). The denominator
 * cannot be read back from the org's model config after the fact: that config
 * is mutable and a finished run must keep the window it launched with.
 *
 * The arithmetic is deliberately NOT re-derived here — it is the same
 * `deriveResponseReserveTokens` the runner feeds to the Pi SDK
 * (`derivePiCompactionSettings`, packages/runner-pi/src/pi-runner.ts) and the
 * same `DEFAULT_CONTEXT_WINDOW` fallback, both from
 * `@appstrate/core/token-budget`. Platform and runner therefore agree by
 * construction for any `(contextWindow, maxTokens)` pair.
 */

import { DEFAULT_CONTEXT_WINDOW, deriveResponseReserveTokens } from "@appstrate/core/token-budget";

/** Persisted context-budget snapshot — the gauge's denominator + threshold. */
export interface RunContextBudget {
  /** Context window the run launched with. Always > 0. */
  contextWindow: number;
  /**
   * Token count at which the runner's auto-compaction kicks in. Always in
   * `(0, contextWindow)` — `deriveResponseReserveTokens` is capped by
   * `RESERVE_CEILING_FRACTION`, so the reserve is strictly below the window
   * even when a corrupt catalog row reports `maxTokens >= contextWindow`.
   */
  compactionThreshold: number;
}

/**
 * Derive the run's context budget from the resolved model. Both inputs are
 * nullable — they come from the catalog cascade (`org_models` rows leave
 * either unset) — and both fallbacks are shared with the runner.
 *
 * A non-positive / non-finite `contextWindow` (a hand-written `org_models`
 * row, a future bad catalog source) is treated as unset rather than trusted:
 * `deriveResponseReserveTokens` would otherwise return a reserve larger than
 * the window and yield a threshold ≤ 0, which the `runs` CHECK constraints
 * reject — turning bad reference data into a failed run creation.
 */
export function deriveRunContextBudget(model: {
  contextWindow?: number | null;
  maxTokens?: number | null;
}): RunContextBudget {
  const declared = model.contextWindow;
  const contextWindow =
    typeof declared === "number" && Number.isFinite(declared) && declared > 0
      ? Math.floor(declared)
      : DEFAULT_CONTEXT_WINDOW;
  const compactionThreshold =
    contextWindow - deriveResponseReserveTokens(contextWindow, model.maxTokens);
  return { contextWindow, compactionThreshold };
}
