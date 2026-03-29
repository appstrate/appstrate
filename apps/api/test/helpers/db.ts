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
 * All table names in dependency-safe order (children first, parents last).
 * Uses DELETE (not TRUNCATE) to avoid AccessExclusiveLock deadlocks with
 * fire-and-forget queries from middleware (e.g., ensureDefaultProfile).
 */
const ALL_TABLES = [
  // Leaf tables (no dependents)
  "webhook_deliveries",
  "execution_logs",
  "package_memories",
  "package_version_dependencies",
  "package_dist_tags",
  "package_configs",
  "user_flow_provider_profiles",
  "org_profile_provider_bindings",
  "user_provider_connections",
  "oauth_states",
  "provider_credentials",
  "package_schedules",
  "org_models",
  "org_provider_keys",
  "org_proxies",
  "org_invitations",
  // Mid-level tables
  "webhooks",
  "executions",
  "package_versions",
  "api_keys",
  "end_users",
  "connection_profiles",
  // Core tables
  "packages",
  "applications",
  "organization_members",
  "organizations",
  "profiles",
  "verification",
  "account",
  '"session"',   // quoted — PostgreSQL reserved word
  '"user"',      // quoted — PostgreSQL reserved word
] as const;

/**
 * Delete all rows from all tables in the test database.
 * Uses DELETE FROM in FK-safe order (children → parents) to avoid deadlocks.
 * Call this in beforeEach() for full test isolation.
 */
export async function truncateAll(): Promise<void> {
  for (const table of ALL_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
}

