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
import EE_TABLES from "../tables.ts";

export { getEeDb };

/**
 * Clear the EE-owned tables — the module writes nothing else, even though its tables
 * share the platform database. The platform `llm_usage` ledger is read through the mock
 * `PlatformServices` (`mock-platform.ts`), reset alongside the rows.
 */
export async function truncateEeTables(): Promise<void> {
  const db = getEeDb();
  for (const table of EE_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  resetMockLedger();
  resetOrgDirectory();
  resetLlmUsageIdSeq();
}
