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
  "org_provider_keys",
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
 * Uses DELETE FROM in FK-safe order (children → parents) to avoid deadlocks.
 * Module-registered tables are truncated first (they reference core tables).
 * Call this in beforeEach() for full test isolation.
 */
export async function truncateAll(): Promise<void> {
  for (const table of extraTables) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  for (const table of CORE_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
}
