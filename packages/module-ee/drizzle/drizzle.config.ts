// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { defineConfig } from "drizzle-kit";

// This module owns its OWN database. `DATABASE_URL` is the PLATFORM database:
// generating or applying these migrations against it would create the `ee_*`
// tables in the wrong place.
const url = process.env.EE_DATABASE_URL;
if (!url) throw new Error("EE_DATABASE_URL is required to run this module's drizzle-kit commands");

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
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
