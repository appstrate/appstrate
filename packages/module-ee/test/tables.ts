// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The module's tables, and the one list of them the tests read: the root harness
 * (`truncateAll()`), `test/helpers/db.ts` and the migration chain test. No foreign keys
 * run between them, so the order is free; it stays children-first because
 * `truncateAll()` deletes in it.
 */
export default [
  "ee_usage_records",
  "ee_billed_llm_usage",
  "ee_billing_cursor",
  "ee_stripe_events",
  "ee_free_tier_claims",
  "ee_billing_managers",
  "ee_billing_accounts",
] as const;
