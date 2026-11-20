// SPDX-License-Identifier: Apache-2.0

/**
 * Shared token-budget arithmetic — the single source of truth for the
 * "response reserve" a model keeps free inside its context window.
 *
 * The reserve is room kept for a reply plus the point where context is
 * summarized — NOT the model's max output. pi-ai clamps the `max_tokens` it
 * sends to `window - estimatedInput - margin` on every API shape, so the
 * reserve no longer protects against an `input + max_tokens > window` 400.
 * Keeping a 384k max output free on a 1M window only made summaries start
 * far too early, hence the absolute {@link RESERVE_CEILING_TOKENS}.
 *
 * Two runtime surfaces use it and MUST agree for a given
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
 * tokens from the same window, so `max_output_tokens < context_window`
 * always holds. Some catalogs report `max_output_tokens == context_window`;
 * {@link deriveResponseReserveTokens} treats any `maxTokens >= contextWindow`
 * as unusable and falls back to a derived default rather than producing a
 * reserve that swallows the window (sidecar boot crash, or a compaction
 * threshold pinned at zero).
 */

/**
 * Limits of a model nothing else sizes: the runner builds it with these, and the chat's
 * gauge sizes a catalog row the same way. Never left undefined: pi-ai clamps `maxTokens`
 * against the window, and NaN goes out as `"max_tokens": null`.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

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
 * Absolute ceiling on the reserve, whatever the window or `maxTokens`.
 * Large enough for a reply plus a summary pass; on a 1M window it puts the
 * summary threshold at 936k instead of the model's whole max output below it.
 */
export const RESERVE_CEILING_TOKENS = 64_000;

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
 * Derive the response reserve (tokens kept free for a reply and the summary
 * trigger) for a context window. Guaranteed to return a positive integer
 * strictly below `contextWindow`.
 *
 *   - A usable explicit `maxTokens` (positive, `< contextWindow`) is the
 *     starting point; a missing or impossible one (`>= contextWindow`) starts
 *     from `max(RESERVE_FLOOR_TOKENS, contextWindow × RESERVE_FRACTION)`.
 *   - The result is capped by {@link RESERVE_CEILING_TOKENS} and by
 *     {@link RESERVE_CEILING_FRACTION} of the window, whichever is lower.
 *
 * Examples: 200k/64k → 64k; 1M/384k → 64k; 1M/null → 64k; 200k/null → 40k.
 *
 * @param contextWindow Positive integer window size (caller guarantees > 0).
 */
export function deriveResponseReserveTokens(
  contextWindow: number,
  maxTokens?: number | null,
): number {
  // Never reserve the whole window: leave ≥20 % for the prompt. Floor at 1
  // so degenerate tiny windows still yield a positive reserve.
  const ceiling = Math.max(
    1,
    Math.min(Math.floor(contextWindow * RESERVE_CEILING_FRACTION), RESERVE_CEILING_TOKENS),
  );
  if (isUsableMaxOutputTokens(maxTokens, contextWindow)) {
    return Math.min(maxTokens, ceiling);
  }
  const derived = Math.max(RESERVE_FLOOR_TOKENS, Math.floor(contextWindow * RESERVE_FRACTION));
  return Math.min(derived, ceiling);
}
