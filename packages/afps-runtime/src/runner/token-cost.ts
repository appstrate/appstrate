// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Single source of the per-token equivalent-cost formula.
 *
 * Both the LLM-proxy meter (`apps/api/.../metering.ts`, over its own camelCase
 * `UpstreamUsage`) and the codex runner's `computeCodexCost` (over the
 * snake_case {@link TokenUsage}) independently spelled out the same
 * `Σ(tokens × rate / 1e6)` arithmetic across input / output / cache-read /
 * cache-write. Centralising it here — where {@link TokenUsage} already lives —
 * means the four-bucket cost shape has ONE definition and cannot drift between
 * the two surfaces.
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
