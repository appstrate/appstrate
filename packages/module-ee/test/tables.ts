// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The module's tables, and the one list of them the tests read.
 *
 * The root harness imports this file for `truncateAll()` — they live in the
 * platform database now, so a core test that seeds an org and a billing account
 * has to see them cleared like every other table. `test/helpers/db.ts` and the
 * migration chain test import it too: three copies of seven names is three
 * places a new table can be forgotten. No foreign keys run between them, so
 * the order below is free; it stays children-first because `truncateAll()`
 * deletes in it.
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
