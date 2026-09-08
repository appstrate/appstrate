// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Credit conversion module.
 *
 * Single source of truth for converting dollars to credits.
 * Current formula: 1 dollar = 1000 credits (i.e. 1 cent = 10 credits).
 *
 * This module will evolve to incorporate run time, model tier, etc.
 */

/**
 * Conversion factor: 1 dollar = this many credits. The ONLY conversion constant
 * — shared by {@link dollarsToCredits} and the cumulative-dollar delta billing
 * SQL in `billing/usage-recorder.ts` (which needs the same multiplier inside a
 * Postgres `round()` expression). Previously derived from a `CREDITS_PER_CENT`
 * constant that had no other consumer; the indirection is gone.
 */
export const CREDITS_PER_DOLLAR = 1000;

/**
 * Convert a dollar cost to credits (always returns a non-negative integer).
 *
 * Rounding rule: `Math.round` is half AWAY FROM ZERO for the non-negative
 * dollars we bill. That same rule is mirrored by the cumulative-dollar delta
 * billing SQL in `billing/usage-recorder.ts`, whose `round()` runs over
 * `numeric` operands (Postgres `round(numeric)` is half away from zero;
 * `round(double precision)` is half to even and would disagree). One rule,
 * shared, so `ee_billing_accounts` and `ee_usage_records` can never drift.
 */
export function dollarsToCredits(dollars: number): number {
  return Math.round(dollars * CREDITS_PER_DOLLAR);
}
