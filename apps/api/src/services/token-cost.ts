// SPDX-License-Identifier: Apache-2.0

/**
 * Ledger price of token usage: Pi's `calculateCost`. A price tier keys on ONE
 * request's input, so usage summed over requests is priced from its tier bands.
 */

import type { TokenUsage } from "@appstrate/afps-shared/token-usage";
import type { ModelCost } from "@appstrate/core/module";
import { piTokenCostUsd, piTokenCounts, usageCostUsd } from "@appstrate/runner-pi/pi-model";

/** One upstream request, tiers honoured. No rate card → 0. */
export function requestCostUsd(usage: TokenUsage, cost: ModelCost | null | undefined): number {
  return cost ? piTokenCostUsd(cost, piTokenCounts(usage)) : 0;
}

/** Usage summed over several requests, priced from its tier bands. No rate card → 0. */
export function cumulativeCostUsd(usage: TokenUsage, cost: ModelCost | null | undefined): number {
  return cost ? usageCostUsd(usage, cost) : 0;
}
