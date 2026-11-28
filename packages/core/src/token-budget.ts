// SPDX-License-Identifier: Apache-2.0

/**
 * Shared token-budget arithmetic — the single source of truth for the
 * "response reserve" a model keeps free inside its context window.
 *
 * The reserve is the room kept for a reply, and `contextWindow - reserve` is
 * the point where context is summarized. It is not a guard against an
 * `input + max_tokens > window` 400: pi-ai clamps the `max_tokens` it sends to
 * the room the estimated input leaves (`clampMaxTokensToContext`), so the
 * reserve stays small on large windows — {@link RESERVE_CEILING_TOKENS}.
 *
 * **Known limit near the threshold.** pi-ai 1.6.0's clamp keeps a margin of
 * `max(4096, 15 % of the input)`; once that margin would leave under 32 768
 * tokens of output, it keeps only the 4 096 margin and caps the reply at
 * 32 768. On a window above ~272k, a context near `window - 64k` is in that
 * regime, so a long reply there can still overflow the window. Pi's overflow
 * recovery (agent-session `isContextOverflow` → summarize and retry) is the
 * backstop. The 64k ceiling is of the order of Claude Code's ~33k buffer
 * and OpenCode's `min(output, 32k)`.
 *
 * Every consumer MUST derive the reserve here, for the same
 * `(contextWindow, maxTokens)` pair, or the spill guard, the summary threshold
 * and what the chat shows drift apart:
 *
 *   - `runtime-pi/sidecar/token-budget.ts` — spills `api_call` output once
 *     `consumed + estimated > contextWindow - reserve`.
 *   - `packages/runner-pi/src/pi-runner.ts` `derivePiCompactionSettings` —
 *     feeds Pi SDK's `shouldCompact(tokens, contextWindow, { reserveTokens })`,
 *     which summarizes once `tokens > contextWindow - reserveTokens`. The run
 *     container and the chat engine (`packages/module-chat/src/pi-chat/engine.ts`)
 *     both size their sessions through it.
 *   - `packages/module-chat/src/ui/model-fit.ts` — the chat's context gauge and
 *     its summary threshold for a catalog row.
 *
 * **Canonical model invariant.** A request consumes `input + output`
 * tokens from the same window, so `max_output_tokens < context_window`
 * always holds. Some catalogs report `max_output_tokens == context_window`;
 * {@link deriveResponseReserveTokens} treats any `maxTokens >= contextWindow`
 * as unusable and falls back to a derived default rather than producing a
 * reserve that swallows the window (sidecar boot crash, or a summary
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
 * Room for a reply and a summary pass; on a 1M window the summary threshold
 * is 936k. It binds once `0.8 × contextWindow` exceeds it (windows above
 * 80k) and the starting point (`maxTokens`, or 20 % of the window) does too.
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
 * trigger) for a context window. Returns a positive integer, strictly below
 * `contextWindow` whenever `contextWindow >= 2`; a 1-token window has no
 * positive integer below it and gets a reserve of 1.
 *
 *   - A usable explicit `maxTokens` (positive, `< contextWindow`) is the
 *     starting point; a missing or impossible one (`>= contextWindow`) starts
 *     from `max(RESERVE_FLOOR_TOKENS, contextWindow × RESERVE_FRACTION)`.
 *   - The result is capped by {@link RESERVE_CEILING_TOKENS} and by
 *     {@link RESERVE_CEILING_FRACTION} of the window, whichever is lower.
 *
 * Examples: 200k/64k → 64k; 1M/384k → 64k; 1M/null → 64k; 300k/null → 60k;
 * 200k/null → 40k.
 *
 * @param contextWindow Integer window size; the caller guarantees `>= 2` for
 *   the reserve to lie below it.
 */
export function deriveResponseReserveTokens(
  contextWindow: number,
  maxTokens?: number | null,
): number {
  // Leave ≥20 % of the window for the prompt. Floor at 1 so a tiny window
  // still yields a positive reserve.
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
