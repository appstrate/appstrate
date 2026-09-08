import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  tablesFilter: [
    "cloud_billing_accounts",
    "cloud_usage_records",
    "cloud_stripe_events",
    "cloud_free_tier_claims",
    "cloud_billed_llm_usage",
    "cloud_billing_cursor",
    "cloud_billing_managers",
  ],
});
