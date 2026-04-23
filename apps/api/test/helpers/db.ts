// SPDX-License-Identifier: Apache-2.0

/**
 * Test database helpers.
 *
 * Provides a Drizzle db instance connected to the test database
 * and helpers for cleaning up between tests.
 */
import { db } from "@appstrate/db/client";
import { sql } from "drizzle-orm";
import type { Db } from "@appstrate/db/client";

export { db };
export type { Db };

/**
 * Core table names in dependency-safe order (children first, parents last).
 * Uses DELETE (not TRUNCATE) to avoid AccessExclusiveLock deadlocks with
 * fire-and-forget queries from middleware (e.g., ensureDefaultProfile).
 *
 * Module-owned tables are NOT listed here — each module extends the truncation
 * list via registerTruncationTables() from its own test preload, so core tests
 * running alone touch only core tables.
 */
const CORE_TABLES = [
  // Leaf tables (no dependents)
  "llm_proxy_usage",
  "run_logs",
  "package_memories",
  "package_version_dependencies",
  "package_dist_tags",
  "application_packages",
  "user_agent_provider_profiles",
  "app_profile_provider_bindings",
  "user_provider_connections",
  "application_provider_credentials",
  "package_schedules",
  "org_models",
  "org_system_provider_keys",
  "org_proxies",
  "org_invitations",
  // Mid-level tables
  "runs",
  "package_versions",
  "api_keys",
  "end_users",
  "connection_profiles",
  // Core tables
  "packages",
  "applications",
  "org_members",
  "organizations",
  "profiles",
  "verification",
  "account",
  '"session"', // quoted — PostgreSQL reserved word
  '"user"', // quoted — PostgreSQL reserved word
] as const;

const extraTables: string[] = [];

/**
 * Register additional (module-owned) tables to include in truncateAll().
 * Module test preloads call this with their tables ordered children-first.
 * Called at preload time before any test runs.
 */
export function registerTruncationTables(tables: readonly string[]): void {
  extraTables.push(...tables);
}

/**
 * Delete all rows from all tables in the test database.
 *
 * Runs inside a single transaction so every DELETE observes the same
 * snapshot. This closes the window in which a previous test's fire-and-
 * forget async work (e.g. `executeAgentInBackground` from the inline-run
 * route writing to `runs`/`run_logs`) could insert a new row between two
 * DELETEs and trigger a FK violation — a concrete source of flaky
 * "organizations_created_by_user_id_fk" / "profiles_pkey" errors we've
 * seen when the harness is under load.
 *
 * Uses DELETE (not TRUNCATE) to avoid AccessExclusiveLock deadlocks with
 * fire-and-forget queries from middleware (e.g., ensureDefaultProfile).
 * Order is children → parents (module tables first, since they reference
 * core tables).
 *
 * Call this in beforeEach() for full test isolation.
 */
export async function truncateAll(): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of extraTables) {
      await tx.execute(sql.raw(`DELETE FROM ${table}`));
    }
    for (const table of CORE_TABLES) {
      await tx.execute(sql.raw(`DELETE FROM ${table}`));
    }
  });
}
