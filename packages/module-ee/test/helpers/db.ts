/**
 * Database helpers for cloud module tests.
 *
 * Provides access to the cloud DB client and a truncation helper
 * that respects foreign key ordering (children first, parents last).
 */
import { getCloudDb } from "../../src/db.ts";
import { sql } from "drizzle-orm";
import { resetMockLedger } from "./mock-platform.ts";
import { resetOrgDirectory } from "./org-queries.ts";
import { resetLlmUsageIdSeq } from "./seed.ts";

export { getCloudDb };

// Cloud-owned tables only — cloud runs its own database and never touches OSS
// tables. The platform `llm_usage` ledger is read through the mock
// `PlatformServices` (see `mock-platform.ts`), reset alongside the DB.
const CLOUD_TABLES = [
  "cloud_usage_records",
  "cloud_billed_llm_usage",
  "cloud_billing_cursor",
  "cloud_stripe_events",
  "cloud_free_tier_claims",
  "cloud_billing_managers",
  "cloud_billing_accounts",
] as const;

export async function truncateCloudTables(): Promise<void> {
  const db = getCloudDb();
  for (const table of CLOUD_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  resetMockLedger();
  resetOrgDirectory();
  resetLlmUsageIdSeq();
}
