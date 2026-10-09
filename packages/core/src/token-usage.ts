// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { parseTokenUsage, type TokenUsage } from "@appstrate/afps-shared/token-usage";

export type { TokenUsage } from "@appstrate/afps-shared/token-usage";

/** {@link parseTokenUsage} as a Zod schema: fails where the snapshot is malformed. */
export const tokenUsageSchema = z.unknown().transform((raw, ctx): TokenUsage => {
  const { usage } = parseTokenUsage(raw);
  if (usage) return usage;
  ctx.addIssue({ code: "custom", message: "invalid token usage" });
  return z.NEVER;
});

/**
 * In-place accumulator for {@link TokenUsage} totals.
 *
 * Adds every counter of `addition` onto `total`. Optional fields default to
 * zero on both sides — `undefined` on `addition` is a no-op, and the
 * cache-creation / cache-read totals are coerced to a numeric zero on
 * `total` so subsequent reads always yield a number. Tier bands are not summed
 * (`addRequestUsage` in `@appstrate/runner-pi/pi-model` does).
 */
export function accumulateTokenUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens = (total.input_tokens ?? 0) + (addition.input_tokens ?? 0);
  total.output_tokens = (total.output_tokens ?? 0) + (addition.output_tokens ?? 0);
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}

/**
 * Symmetric read of {@link accumulateTokenUsage} — the single number that
 * describes a {@link TokenUsage} record. Sums all four buckets, treating an
 * absent field as zero.
 *
 * It exists because `input_tokens` is NET of cache by construction: the
 * normalisation at the adapter boundary carves `cache_read` and
 * `cache_creation` back out of the provider's total prompt count (see
 * `docs/architecture/RUN_COST.md`). A two-bucket `input + output` sum
 * therefore under-reports — severely so — whenever prompt caching is active,
 * and silently disagrees with the cost figure, which prices all four.
 *
 * The result is a CUMULATIVE spend total across every turn of a run or
 * session, not a live gauge of the current context window: a cached prompt
 * re-read on ten turns contributes ten times. Do not present it as
 * "context used".
 */
export function totalTokens(usage: TokenUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}
