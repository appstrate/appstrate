// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** The token counters of a {@link TokenUsage}; the types derive from it. */
export const TOKEN_USAGE_COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

type TokenUsageCounter = (typeof TOKEN_USAGE_COUNTERS)[number];

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
  /** Summed usage, per tier threshold: the tokens of the requests priced at that tier. */
  tiers?: TokenUsageTier[];
}

/**
 * The share of a {@link TokenUsage} priced at the tier above `input_tokens_above`.
 *
 * `input_tokens_above` is compared to a request's whole prompt (input + cache read + cache
 * write), while the band's own counters stay net of cache like the usage's. It is the join key
 * with a rate card tier's `inputTokensAbove`.
 */
export interface TokenUsageTier extends TokenUsageCounters {
  input_tokens_above: number;
}

/** Bounds what is stored verbatim from untrusted runners; a Pi card has one or two tiers. */
export const MAX_TOKEN_USAGE_TIERS = 16;

/** A {@link TokenUsage} counter the wire can carry: a non-negative safe integer. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const TIER_KEYS = new Set<string>(["input_tokens_above", ...TOKEN_USAGE_COUNTERS]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The {@link TokenUsage.tiers} rule: capped, strict keys, unique positive integer thresholds. */
export function isTokenUsageTiers(value: unknown): value is TokenUsageTier[] {
  if (!Array.isArray(value) || value.length > MAX_TOKEN_USAGE_TIERS) return false;
  const thresholds = new Set<number>();
  for (const tier of value) {
    if (!isPlainObject(tier)) return false;
    if (Object.keys(tier).some((key) => !TIER_KEYS.has(key))) return false;
    const threshold = tier.input_tokens_above;
    if (typeof threshold !== "number" || !Number.isSafeInteger(threshold)) return false;
    if (threshold < 1 || thresholds.has(threshold)) return false;
    thresholds.add(threshold);
    if (TOKEN_USAGE_COUNTERS.some((c) => tier[c] !== undefined && !isTokenCount(tier[c]))) {
      return false;
    }
  }
  return true;
}

/**
 * The one {@link TokenUsage} rule, applied at every seam that reads untrusted usage. A counter
 * that fails {@link isTokenCount}, or a value that is not an object, makes the snapshot malformed
 * (`usage` null). Keys outside the declared ones are dropped. Bands that fail
 * {@link isTokenUsageTiers} are dropped alone and flagged, so the counters still price, at the
 * base rate.
 */
export function parseTokenUsage(raw: unknown): {
  usage: TokenUsage | null;
  tiersDropped: boolean;
} {
  if (!isPlainObject(raw)) return { usage: null, tiersDropped: false };
  const usage: TokenUsage = {};
  for (const counter of TOKEN_USAGE_COUNTERS) {
    const value = raw[counter];
    if (value === undefined) continue;
    if (!isTokenCount(value)) return { usage: null, tiersDropped: false };
    usage[counter] = value;
  }
  if (raw.tiers === undefined) return { usage, tiersDropped: false };
  if (!isTokenUsageTiers(raw.tiers)) return { usage, tiersDropped: true };
  usage.tiers = raw.tiers;
  return { usage, tiersDropped: false };
}
