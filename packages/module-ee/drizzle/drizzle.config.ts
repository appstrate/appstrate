// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  tablesFilter: [
    "ee_billing_accounts",
    "ee_usage_records",
    "ee_stripe_events",
    "ee_free_tier_claims",
    "ee_billed_llm_usage",
    "ee_billing_cursor",
    "ee_billing_managers",
  ],
});
