// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Pi-runtime defaults consumed by both the platform-side runner
 * (`@appstrate/runner-pi`) and the sidecar's TokenBudget
 * (`runtime-pi/sidecar/token-budget.ts`). Centralised here because the
 * two surfaces must agree on the same numbers — divergence causes the
 * compaction threshold and the spill guard to drift apart for the same
 * model, which is the failure mode #464 originally surfaced.
 *
 * Bump these only when both downstreams are ready for the new value.
 */

/**
 * Response budget used when the resolved model carries no `maxTokens`.
 * 16384 covers the common "no thinking" Claude / GPT response shape;
 * larger budgets (Sonnet thinking @ 64 k) override via the model's own
 * `maxTokens`. Read by:
 *   - `runner-pi` as the Pi SDK compaction `reserveTokens`,
 *   - `sidecar/token-budget` as the floor on the derived TokenBudget
 *     `reserveTokens` when only `contextWindowTokens` was forwarded.
 */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * Fallback context window when the model omits it entirely. Matches the
 * Claude family's standard 200 k window — the most common runtime
 * target. Read by `runner-pi` to size Pi SDK compaction; the sidecar's
 * `TokenBudget` treats a missing context window differently (no
 * window-guard) and does not consume this default.
 */
export const PI_DEFAULT_CONTEXT_WINDOW = 200_000;
