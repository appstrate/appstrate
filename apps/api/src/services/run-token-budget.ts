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
 * **Where platform and runner agree, and where they deliberately do not.**
 * When the resolved model DECLARES a context window, the arithmetic here is
 * the same `deriveResponseReserveTokens` (`@appstrate/core/token-budget`) the
 * runner feeds to the Pi SDK via `derivePiCompactionSettings`
 * (packages/runner-pi/src/pi-runner.ts), so the persisted threshold is the
 * point at which that run really compacts.
 *
 * When the model declares NO window, the platform stores NULL and renders no
 * gauge rather than guessing. It has to: `buildRuntimePiEnv`
 * (packages/runner-pi/src/container-env.ts) omits `MODEL_CONTEXT_WINDOW`
 * entirely for a null window, and the container then applies its OWN
 * `DEFAULT_CONTEXT_WINDOW` (128 000, runtime-pi/env.ts) — a different number
 * from core's 200 000. Persisting core's fallback would draw a 200 000-token
 * gauge over a run that actually ran, and compacted, against 128 000: the
 * gauge would read ~64 % at true saturation and mark a compaction line the run
 * can never reach. Aligning the two constants instead was rejected — raising
 * the container's 128 000 changes live prompt sizing on every deployment whose
 * model really is a 128 k model, pushing requests past the provider's real
 * limit into upstream 400s. A missing gauge is the far cheaper failure.
 */

import { deriveResponseReserveTokens } from "@appstrate/core/token-budget";

/**
 * Smallest window for which a budget satisfying the `runs` CHECK constraints
 * exists. The threshold must be an integer in `(0, contextWindow)`, and that
 * interval contains no integer below 2.
 */
const MIN_DERIVABLE_CONTEXT_WINDOW = 2;

/** Persisted context-budget snapshot — the gauge's denominator + threshold. */
export interface RunContextBudget {
  /** Context window the run launched with. Always an integer > 0. */
  contextWindow: number;
  /**
   * Token count at which the runner's auto-compaction kicks in. Always an
   * integer in `(0, contextWindow)` — clamped here, not merely inherited from
   * `deriveResponseReserveTokens`, so the value is insertable by construction.
   */
  compactionThreshold: number;
}

/**
 * Derive the run's context budget from the resolved model, or `null` when no
 * honest budget exists.
 *
 * The load-bearing contract: **whatever this returns, `createRun` must be able
 * to insert.** The `runs` CHECK constraints require
 * `0 < compaction_threshold < context_window` with both columns integral, so a
 * derivation that emits a bad pair does not degrade the gauge — it aborts run
 * creation with an opaque 500. Every clamp below exists for that reason.
 *
 * Returns `null` when:
 *   - the model declares no window (see the module docblock — the platform
 *     genuinely does not know it, and the container's default differs), or
 *   - the declared window is not a finite number, or floors below
 *     {@link MIN_DERIVABLE_CONTEXT_WINDOW} (a hand-written `org_models` row, a
 *     future bad catalog source). No pair satisfying the CHECKs exists there,
 *     and NULL — "unknown", already rendered as "no gauge" end to end — beats a
 *     row the database will refuse.
 *
 * Neither `contextWindow` nor `maxTokens` is guaranteed integral: both reach
 * this function from `SYSTEM_PROVIDER_KEYS` (`services/model-registry.ts`),
 * which validates them with `z.number().positive()` and no `.int()`. Hence the
 * explicit `Math.floor` on the window BEFORE the positivity test, and the
 * integer clamp on the reserve — `deriveResponseReserveTokens` honours a
 * fractional `maxTokens` verbatim and would otherwise hand a fractional
 * threshold to an `integer` column.
 */
export function deriveRunContextBudget(model: {
  contextWindow?: number | null;
  maxTokens?: number | null;
}): RunContextBudget | null {
  const declared = model.contextWindow;
  if (typeof declared !== "number" || !Number.isFinite(declared)) return null;
  const contextWindow = Math.floor(declared);
  if (contextWindow < MIN_DERIVABLE_CONTEXT_WINDOW) return null;

  // Clamp into [1, contextWindow - 1]: non-empty because contextWindow >= 2.
  // Guarantees `compactionThreshold = contextWindow - reserve` is an integer in
  // [1, contextWindow - 1] ⊂ (0, contextWindow) — exactly the CHECK.
  const reserve = Math.min(
    Math.max(1, Math.floor(deriveResponseReserveTokens(contextWindow, model.maxTokens))),
    contextWindow - 1,
  );
  return { contextWindow, compactionThreshold: contextWindow - reserve };
}
