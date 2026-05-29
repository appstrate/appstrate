// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { TokenUsage } from "@appstrate/afps-shared/token-usage";

/**
 * Canonical token-usage shape — the definition now lives in the zero-dep leaf
 * package `@appstrate/afps-shared`. Re-exported here so the public
 * `@appstrate/core/token-usage` import path stays stable for existing consumers.
 */
export type { TokenUsage } from "@appstrate/afps-shared/token-usage";

/**
 * Token usage as reported by an LLM provider for a single completion call.
 * Wire shape consumed by the runner-event ingestion route and any
 * cost-accounting consumer.
 */
export const tokenUsageSchema = z.object({
  input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative().optional(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
});

/**
 * In-place accumulator for {@link TokenUsage} totals.
 *
 * Adds every field of `addition` onto `total`. Optional fields default to
 * zero on both sides — `undefined` on `addition` is a no-op, and the
 * cache-creation / cache-read totals are coerced to a numeric zero on
 * `total` so subsequent reads always yield a number.
 */
export function accumulateTokenUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens = (total.input_tokens ?? 0) + (addition.input_tokens ?? 0);
  total.output_tokens = (total.output_tokens ?? 0) + (addition.output_tokens ?? 0);
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}
