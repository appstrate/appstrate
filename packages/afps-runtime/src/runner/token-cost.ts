// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Pricing provenance of a ledger row's cost: whether the rates it was priced
 * with cover the consumption it records.
 */

import type { TokenUsage } from "../types/run-result.ts";

/**
 * Per-million-token USD rates. Structurally a subset of `@appstrate/core`'s
 * `ModelCost`, declared locally so this leaf helper takes no dependency on it.
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

/**
 * How much of a ledger row's cost is backed by real rates.
 *
 * - `priced` — every bucket that carried tokens had a rate.
 * - `partial` — a number was produced, but part of the consumption was priced at zero
 *   because a rate was missing (not because it is free).
 * - `unpriced` — no rates at all; the `0` is an absence of pricing, not a free run.
 */
export type TokenPricingStatus = "priced" | "partial" | "unpriced";

/**
 * Classify the provenance of a ledger row's cost.
 *
 * The platform's price is deliberately permissive — no rates price at 0, and so does an
 * absent cache rate — which is correct arithmetic but makes "no pricing exists for this
 * model" indistinguishable from "this consumption was genuinely free". This classifier
 * is the missing half: it says whether the number can be trusted, without changing it.
 *
 * `input`/`output` never need checking: they are REQUIRED on {@link TokenCost}, so the
 * only way they can be absent is `cost` itself being absent — the `unpriced` branch.
 *
 * **A missing `cacheWrite` rate deliberately does NOT downgrade a row to `partial`**,
 * even when cache-creation tokens were reported. Two reasons:
 * 1. Several vendors legitimately bill no cache-write premium, so "no rate" is often the
 *    correct price rather than a gap.
 * 2. Rate cards from outside Pi's registry (an override, a gateway's price list)
 *    routinely omit it; flagging on it would mark correctly priced rows `partial`.
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
