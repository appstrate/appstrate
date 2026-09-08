// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The module's tables, for the root harness `truncateAll()` — they live in the
 * platform database now, so a core test that seeds an org and a billing account
 * has to see them cleared like every other table. No foreign keys run between
 * them; the order mirrors `test/helpers/db.ts`.
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
