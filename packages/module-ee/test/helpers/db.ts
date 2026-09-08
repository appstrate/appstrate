// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Database helpers for EE module tests.
 *
 * Provides access to the EE DB client and a truncation helper
 * that respects foreign key ordering (children first, parents last).
 */
import { getEeDb } from "../../src/db.ts";
import { sql } from "drizzle-orm";
import { resetMockLedger } from "./mock-platform.ts";
import { resetOrgDirectory } from "./org-queries.ts";
import { resetLlmUsageIdSeq } from "./seed.ts";

export { getEeDb };

// EE-owned tables only — the module writes nothing else, even though its
// tables now share the platform database. The platform `llm_usage` ledger is
// read through the mock `PlatformServices` (see `mock-platform.ts`), reset
// alongside the rows.
const EE_TABLES = [
  "ee_usage_records",
  "ee_billed_llm_usage",
  "ee_billing_cursor",
  "ee_stripe_events",
  "ee_free_tier_claims",
  "ee_billing_managers",
  "ee_billing_accounts",
] as const;

export async function truncateEeTables(): Promise<void> {
  const db = getEeDb();
  for (const table of EE_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  resetMockLedger();
  resetOrgDirectory();
  resetLlmUsageIdSeq();
}
