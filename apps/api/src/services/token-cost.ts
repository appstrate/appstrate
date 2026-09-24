// SPDX-License-Identifier: Apache-2.0

/**
 * Ledger price of token usage: Pi's `calculateCost`. A price tier keys on ONE
 * request's input, so usage summed over requests is priced at the base rate.
 */

import type { TokenUsage } from "@appstrate/afps-shared/token-usage";
import type { ModelCost } from "@appstrate/core/module";
import { piTokenCostUsd } from "@appstrate/runner-pi/pi-model";

function piUsage(usage: TokenUsage) {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

/** One upstream request, tiers honoured. No rate card → 0. */
export function requestCostUsd(usage: TokenUsage, cost: ModelCost | null | undefined): number {
  return cost ? piTokenCostUsd(cost, piUsage(usage)) : 0;
}

/** Usage summed over several requests, at the base rate. No rate card → 0. */
export function aggregatedCostUsd(usage: TokenUsage, cost: ModelCost | null | undefined): number {
  return cost ? piTokenCostUsd({ ...cost, tiers: [] }, piUsage(usage)) : 0;
}
