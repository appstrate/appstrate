// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { defineConfig } from "drizzle-kit";

// This module's tables live in the PLATFORM database, under their own journal
// (`drizzle.ee_migrations`) so drizzle-kit never reads or writes the platform's
// `drizzle.__drizzle_migrations`. Both must match `migrateEeDb` in `src/db.ts`.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required to run this module's drizzle-kit commands");

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  migrations: { table: "ee_migrations", schema: "drizzle" },
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
