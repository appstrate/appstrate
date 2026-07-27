// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Single source of the per-token equivalent-cost formula.
 *
 * Both the LLM-proxy meter (`apps/api/.../metering.ts`, over its own camelCase
 * `UpstreamUsage`) and the codex runner (over the snake_case {@link TokenUsage})
 * independently spelled out the same `Σ(tokens × rate / 1e6)` arithmetic across
 * input / output / cache-read / cache-write. Centralising it here — where
 * {@link TokenUsage} already lives — means the four-bucket cost shape has ONE
 * definition and cannot drift between the two surfaces.
 */

import type { TokenUsage } from "../types/run-result.ts";

/**
 * Per-million-token USD rates. Structurally identical to `@appstrate/core`'s
 * `ModelCost` and the codex runner's `CodexModelCost`, declared locally so this
 * leaf helper takes no dependency on either consumer's cost type — both are
 * assignable to it.
 */
export interface TokenCost {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens. */
  cacheRead?: number;
  /** USD per 1M cache-write (cache-creation) tokens. */
  cacheWrite?: number;
}

const PER_MILLION = 1_000_000;

/**
 * Equivalent cost (USD) for a {@link TokenUsage} at the given per-million rates.
 * `null`/`undefined` cost → 0. Absent token counts or cache rates count as 0.
 */
export function computeTokenCost(usage: TokenUsage, cost: TokenCost | null | undefined): number {
  if (!cost) return 0;
  const inputCost = ((usage.input_tokens ?? 0) * cost.input) / PER_MILLION;
  const outputCost = ((usage.output_tokens ?? 0) * cost.output) / PER_MILLION;
  const cacheReadCost =
    ((usage.cache_read_input_tokens ?? 0) * (cost.cacheRead ?? 0)) / PER_MILLION;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens ?? 0) * (cost.cacheWrite ?? 0)) / PER_MILLION;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * How much of a {@link computeTokenCost} result is backed by real rates.
 *
 * - `priced` — every bucket that carried tokens had a rate.
 * - `partial` — a number was produced, but part of the consumption was priced at zero
 *   because a rate was missing (not because it is free).
 * - `unpriced` — no rates at all; the `0` is an absence of pricing, not a free run.
 */
export type TokenPricingStatus = "priced" | "partial" | "unpriced";

/**
 * Classify the provenance of the cost {@link computeTokenCost} would return.
 *
 * `computeTokenCost` is deliberately permissive — `if (!cost) return 0` and `?? 0` on
 * both cache rates — which is correct arithmetic but makes "no pricing exists for this
 * model" indistinguishable from "this consumption was genuinely free". This classifier
 * is the missing half: it says whether the number can be trusted, without changing it.
 *
 * `input`/`output` never need checking: they are REQUIRED on {@link TokenCost}, so the
 * only way they can be absent is `cost` itself being absent — the `unpriced` branch.
 *
 * **A missing `cacheWrite` rate deliberately does NOT downgrade a row to `partial`**,
 * even when cache-creation tokens were reported. Three reasons:
 * 1. Several vendors legitimately bill no cache-write premium, so "no rate" is often the
 *    correct price rather than a gap.
 * 2. In the vendored catalog an absent field and a `0` field are indistinguishable — the
 *    refresh script simply omits what the upstream price list does not state.
 * 3. Empirically only 5 of 89 `openai` entries and 0 of 40 `xai` entries carry
 *    `cacheWrite`. Flagging on it would mark nearly every row `partial` and destroy the
 *    signal this status exists to carry.
 *
 * A missing `cacheRead` rate while the provider actually reported cached input tokens is
 * the opposite case, and the actionable one: those tokens were real consumption priced at
 * exactly zero, and the four-bucket normalisation has ALREADY subtracted them from the
 * `input` bucket (`input = max(0, prompt_tokens − cacheRead − cacheWrite)`, see
 * `docs/architecture/RUN_COST.md`) — so they are billed in no bucket at all. That is a
 * silent undercount, and it is what `partial` marks.
 */
export function classifyTokenPricing(
  usage: TokenUsage,
  cost: TokenCost | null | undefined,
): TokenPricingStatus {
  if (cost == null) return "unpriced";
  // `== null` on purpose: an explicit `cacheRead: 0` is a real price (some vendors do
  // serve cache reads for free), not a missing rate.
  if (cost.cacheRead == null && (usage.cache_read_input_tokens ?? 0) > 0) return "partial";
  return "priced";
}
