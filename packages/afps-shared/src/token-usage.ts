// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** The token counters of a {@link TokenUsage} — declared once, the types derive from it. */
export const TOKEN_USAGE_COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

type TokenUsageCounter = (typeof TOKEN_USAGE_COUNTERS)[number];

/** Every token counter, each optional. */
type TokenUsageCounters = { [K in TokenUsageCounter]?: number };

/**
 * Canonical token-usage shape reported by an LLM provider for a completion.
 *
 * Wire format is snake_case (AFPS `appstrate.metric` event, the platform's
 * `runs.tokenUsage` JSONB column, the runner-event ingestion route, and every
 * cost-accounting consumer). Every field is OPTIONAL — this is the widest
 * shape and matches wire reality where usage may be partial. It is the single
 * definition re-exported by `@appstrate/core/token-usage`,
 * `@appstrate/shared-types`, `@appstrate/afps-runtime`, the Drizzle schema, the
 * web realtime hooks, and the CLI runner.
 */
export interface TokenUsage extends TokenUsageCounters {
  /**
   * Usage summed over several requests keeps what a price tier needs: one
   * entry per tier threshold, holding the tokens of the requests priced at
   * that tier (input + cache-read + cache-write above `input_tokens_above`).
   * A subset of the counters above, which still count every request. Absent
   * when no request reached a tier. Validated by {@link isTokenUsageTiers}.
   */
  tiers?: TokenUsageTier[];
}

/** The share of a {@link TokenUsage} priced at the tier above `input_tokens_above`. */
export interface TokenUsageTier extends TokenUsageCounters {
  input_tokens_above: number;
}

/**
 * Most bands a {@link TokenUsage.tiers} may hold. A Pi model card carries one
 * or two tiers; the cap bounds what is stored verbatim from untrusted runners.
 */
export const MAX_TOKEN_USAGE_TIERS = 16;

/** A {@link TokenUsage} counter the wire can carry: finite and non-negative. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const isWholeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const TIER_KEYS = new Set<string>(["input_tokens_above", ...TOKEN_USAGE_COUNTERS]);

/**
 * The rule for {@link TokenUsage.tiers}, shared by every validator of the wire
 * shape: at most {@link MAX_TOKEN_USAGE_TIERS} objects, each holding only a
 * positive integer `input_tokens_above` unique across entries and non-negative
 * integer counters (Pi thresholds and token counts are integers).
 */
export function isTokenUsageTiers(value: unknown): value is TokenUsageTier[] {
  if (!Array.isArray(value) || value.length > MAX_TOKEN_USAGE_TIERS) return false;
  const thresholds = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const tier = entry as Record<string, unknown>;
    if (Object.keys(tier).some((key) => !TIER_KEYS.has(key))) return false;
    const threshold = tier.input_tokens_above;
    if (!isWholeCount(threshold) || threshold === 0 || thresholds.has(threshold)) return false;
    thresholds.add(threshold);
    if (TOKEN_USAGE_COUNTERS.some((c) => tier[c] !== undefined && !isWholeCount(tier[c]))) {
      return false;
    }
  }
  return true;
}
