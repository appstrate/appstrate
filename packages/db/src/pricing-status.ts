// SPDX-License-Identifier: Apache-2.0

/**
 * Pricing-provenance literals — the value set of `llm_usage.pricing_status`
 * and `runs.cost_pricing_status`.
 *
 * **This module MUST stay import-free**, for the same reason as
 * `run-status.ts`: it is reached from the browser bundle
 * (`@appstrate/shared-types` builds the `run_metric` SSE Zod enum from these
 * values), and any import added here would drag the schema barrel — table and
 * column names included — into a public asset.
 *
 * The vocabulary itself is defined by `TokenPricingStatus`
 * (`@appstrate/afps-runtime/runner`, where the classifier that produces it
 * lives). It is restated here rather than imported because the runtime package
 * has no business being in the browser graph — the two are kept in lockstep by
 * the ledger writer, which is typed against BOTH.
 */

export const pricingStatusValues = ["priced", "partial", "unpriced"] as const;

/**
 * How much of a recorded `cost_usd` is backed by real per-token rates.
 *
 * `cost_usd = 0` alone is unattributable: it may be a genuinely free
 * subscription-backed model, a model the platform simply failed to price, or a
 * call whose cached fraction was priced at zero because the rate was absent.
 * This vocabulary is what makes the three distinguishable in SQL:
 *
 *  - `priced` — every bucket that carried tokens had a rate.
 *  - `partial` — a number was produced, but part of the consumption was priced
 *    at zero because a rate was missing (not because it is free). The figure is
 *    a floor.
 *  - `unpriced` — no rates at all; the `0` is an absence of pricing, not a free
 *    call.
 *
 * NULL always means "written before this column existed", never "priced".
 */
export type PricingStatus = (typeof pricingStatusValues)[number];
