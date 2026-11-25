// SPDX-License-Identifier: Apache-2.0

/**
 * Database helpers for billing module tests.
 *
 * Provides access to the billing DB client and a truncation helper
 * that respects foreign key ordering (children first, parents last).
 */
import { getBillingDb } from "../../src/db.ts";
import { sql } from "drizzle-orm";
import { resetMockLedger, resetMockRuns } from "./mock-platform.ts";
import { resetOrgDirectory } from "./org-queries.ts";
import { resetLlmUsageIdSeq } from "./seed.ts";
import EE_TABLES from "../tables.ts";

export { getBillingDb };

/**
 * Clear the module-owned tables — the module writes nothing else, even though its tables
 * share the platform database. The platform `llm_usage` ledger is read through the mock
 * `PlatformServices` (`mock-platform.ts`), reset alongside the rows.
 */
export async function truncateBillingTables(): Promise<void> {
  const db = getBillingDb();
  for (const table of EE_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  resetMockLedger();
  resetMockRuns();
  resetOrgDirectory();
  resetLlmUsageIdSeq();
}
