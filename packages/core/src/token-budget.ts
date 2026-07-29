// SPDX-License-Identifier: Apache-2.0

/**
 * Shared token-budget arithmetic — the single source of truth for the
 * "response reserve" a model keeps free inside its context window.
 *
 * The reserve is used by two runtime surfaces that MUST agree for a given
 * `(contextWindow, maxTokens)` pair, or the spill guard and the compaction
 * threshold drift apart:
 *
 *   - `runtime-pi/sidecar/token-budget.ts` — spills `api_call` output once
 *     `consumed + estimated > contextWindow - reserve`.
 *   - `packages/runner-pi/src/pi-runner.ts` — feeds Pi SDK's
 *     `shouldCompact(tokens, contextWindow, { reserveTokens })`, which
 *     compacts once `tokens > contextWindow - reserveTokens`.
 *
 * **Canonical model invariant.** A request consumes `input + output`
 * tokens, both drawn from the same context window, so
 * `max_output_tokens < context_window` always holds — output can never
 * occupy the entire window because the prompt needs room too. Our catalog
 * is sourced from LiteLLM / models.dev, which report
 * `max_output_tokens == context_window` for a class of models (devstral,
 * kimi-k2.5, several grok / mistral entries) — a known upstream data bug
 * (see LiteLLM issue #22478). The ingest path drops those to null, but the
 * runtime can still receive an impossible cap (manual `org_models` row, a
 * future bad source), so {@link deriveResponseReserveTokens} treats any
 * `maxTokens >= contextWindow` as unusable and falls back to a derived
 * default rather than producing a reserve that swallows the whole window
 * (which previously threw and crashed the sidecar at boot, or pinned the
 * compaction threshold at zero so the agent compacted every turn).
 */

/**
 * Fallback context window when the resolved model omits it. Matches the
 * Claude family's standard 200 k window — the most common runtime target.
 *
 * **Scope — read before reusing it.** This is NOT a platform-wide default that
 * every surface applies to a null window. Exactly two consumers read it, and
 * both are places that must produce *some* window to proceed at all:
 *
 *   - `derivePiCompactionSettings` (packages/runner-pi/src/pi-runner.ts) —
 *     sizes compaction for an in-process Pi session.
 *   - `apps/cli/src/commands/run/model.ts` — the standalone CLI's model preset.
 *
 * Three surfaces deliberately do NOT:
 *
 *   - `runtime-pi/env.ts` declares its own `DEFAULT_CONTEXT_WINDOW` of 128 000
 *     for `MODEL_CONTEXT_WINDOW`, which `buildRuntimePiEnv` omits when the
 *     model's window is null. Containerised runs on an undeclared window
 *     therefore run against 128 k, not this constant.
 *   - `runtime-pi/sidecar/token-budget.ts` applies no default at all — an
 *     absent `contextWindowTokens` disables the spill guard rather than
 *     inventing a window to guard against.
 *   - `runs.context_window` (the dashboard gauge denominator) stores NULL for
 *     an undeclared window; see `apps/api/src/services/run-token-budget.ts`.
 *
 * So do not "unify" a null-window default across surfaces on the strength of
 * this constant existing — the divergences are load-bearing, not drift.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Floor on the derived response reserve when no usable `maxTokens` is
 * available. 16384 covers the common "no thinking" Claude / GPT response
 * shape; larger budgets (Sonnet thinking @ 64 k) flow through an explicit
 * `maxTokens`.
 */
export const RESERVE_FLOOR_TOKENS = 16_384;

/**
 * Fraction of the context window reserved for the response when no usable
 * `maxTokens` is supplied. 20 % covers Sonnet thinking @ 64 k on a 200 k
 * window without overshooting; smaller windows scale down naturally.
 */
export const RESERVE_FRACTION = 0.2;

/**
 * Hard ceiling on the reserve as a fraction of the window — always leave
 * at least `1 - RESERVE_CEILING_FRACTION` (20 %) for the prompt, even when
 * an explicit `maxTokens` is large relative to the window. Guarantees the
 * returned reserve is strictly below `contextWindow`.
 */
export const RESERVE_CEILING_FRACTION = 0.8;

/**
 * True when `maxTokens` is a usable response cap for `contextWindow`: a
 * positive integer strictly below the window. Encodes the canonical
 * `input + output <= context` invariant — a cap `>= contextWindow` is
 * mathematically impossible and signals corrupt catalog/override data.
 */
export function isUsableMaxOutputTokens(
  maxTokens: number | null | undefined,
  contextWindow: number,
): maxTokens is number {
  return (
    typeof maxTokens === "number" &&
    Number.isFinite(maxTokens) &&
    maxTokens > 0 &&
    maxTokens < contextWindow
  );
}

/**
 * Derive the response reserve (tokens kept free for the model's reply) for
 * a context window. Guaranteed to return a positive integer strictly below
 * `contextWindow`.
 *
 *   - A usable explicit `maxTokens` (positive, `< contextWindow`) is
 *     honoured verbatim — capped only by {@link RESERVE_CEILING_FRACTION}
 *     so a near-window cap still leaves prompt headroom. This preserves
 *     existing behaviour for every valid model (e.g. Sonnet thinking
 *     @ 64 k on a 200 k window stays 64 k).
 *   - A missing or impossible `maxTokens` (`>= contextWindow`) falls back
 *     to `max(RESERVE_FLOOR_TOKENS, contextWindow × RESERVE_FRACTION)`,
 *     itself clamped under the ceiling.
 *
 * @param contextWindow Positive integer window size (caller guarantees > 0).
 */
export function deriveResponseReserveTokens(
  contextWindow: number,
  maxTokens?: number | null,
): number {
  // Never reserve the whole window: leave ≥20 % for the prompt. Floor at 1
  // so degenerate tiny windows still yield a positive reserve.
  const ceiling = Math.max(1, Math.floor(contextWindow * RESERVE_CEILING_FRACTION));
  if (isUsableMaxOutputTokens(maxTokens, contextWindow)) {
    return Math.min(maxTokens, ceiling);
  }
  const derived = Math.max(RESERVE_FLOOR_TOKENS, Math.floor(contextWindow * RESERVE_FRACTION));
  return Math.min(derived, ceiling);
}
