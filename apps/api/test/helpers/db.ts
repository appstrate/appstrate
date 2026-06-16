// SPDX-License-Identifier: Apache-2.0

/**
 * Test database helpers.
 *
 * Provides a Drizzle db instance connected to the test database
 * and helpers for cleaning up between tests.
 */
import { db, closeDb } from "@appstrate/db/client";
import { sql } from "drizzle-orm";
import type { Db } from "@appstrate/db/client";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export { db, closeDb };
export type { Db };

/**
 * Reset the filesystem storage namespace between tests (tier0 / FS mode).
 *
 * tier0 points `FS_STORAGE_PATH` at one per-process temp dir shared by every
 * test FILE (see `test/setup/preload.ts`). `truncateAll` resets the DB but the
 * storage bucket files (`<bucket>/<pkg>/<version>.afps`, run workspaces, …)
 * persisted across files — so a stale artifact uploaded by file A under a
 * fixed package id (e.g. `@mcporg/local-server`) leaked into file B that
 * reused the same id, making whole-suite runs flaky in a way isolated runs
 * never showed. Wiping the storage root's contents alongside the DB delete
 * makes storage isolation match DB isolation.
 *
 * No-op when S3 storage is configured (tier3 / MinIO) — there is no FS path to
 * clear, and the bucket lifecycle is owned by Docker Compose, not the test
 * harness. Best-effort: a teardown failure must never mask the test outcome.
 */
function resetFsStorage(): void {
  if (process.env.S3_BUCKET) return; // S3 mode — not filesystem-backed.
  const root = process.env.FS_STORAGE_PATH;
  if (!root) return;
  try {
    // Remove the bucket subtrees but keep the root dir itself (the storage
    // adapter recreates bucket dirs lazily on the next upload).
    for (const entry of readdirSync(root)) {
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  } catch {
    // Root may not exist yet (no upload happened) — nothing to clear.
  }
}

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
  "audit_events",
  "llm_usage",
  "credential_proxy_usage",
  "run_logs",
  "package_persistence",
  "package_version_dependencies",
  "package_dist_tags",
  "application_packages",
  "integration_connections",
  "integration_oauth_clients",
  "package_schedules",
  "org_models",
  "model_provider_credentials",
  "org_proxies",
  "org_invitations",
  // Mid-level tables
  "runs",
  "package_versions",
  "api_keys",
  "end_users",
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
  cachedTruncateSql = null; // invalidate — rebuilt on next truncateAll()
}

/** Cached DO-block SQL — rebuilt lazily after registerTruncationTables(). */
let cachedTruncateSql: string | null = null;

function buildTruncateSql(): string {
  const deletes = [...extraTables, ...CORE_TABLES]
    .map((table) => `DELETE FROM ${table};`)
    .join("\n");
  return `DO $$ BEGIN\n${deletes}\nEND $$;`;
}

/**
 * Delete all rows from all tables in the test database.
 *
 * All DELETEs are wrapped in a single plpgsql `DO $$ ... $$` block — one
 * statement, one network roundtrip (vs ~26 sequential roundtrips before),
 * which matters since this runs in beforeEach across the whole suite.
 * A DO block executes atomically within a single implicit transaction, so
 * every DELETE observes the same snapshot. This closes the window in which
 * a previous test's fire-and-forget async work (e.g.
 * `executeAgentInBackground` from the inline-run route writing to
 * `runs`/`run_logs`) could insert a new row between two DELETEs and
 * trigger a FK violation — a concrete source of flaky
 * "organizations_created_by_user_id_fk" / "profiles_pkey" errors we've
 * seen when the harness is under load.
 *
 * Uses DELETE (not TRUNCATE) to avoid AccessExclusiveLock deadlocks with
 * fire-and-forget queries from middleware (e.g., ensureDefaultProfile).
 * Order is children → parents (module tables first, since they reference
 * core tables).
 *
 * Also resets the filesystem storage namespace (tier0 / FS mode) so storage
 * isolation between test files matches DB isolation — see {@link resetFsStorage}.
 *
 * Call this in beforeEach() for full test isolation.
 */
export async function truncateAll(): Promise<void> {
  cachedTruncateSql ??= buildTruncateSql();
  await db.execute(sql.raw(cachedTruncateSql));
  resetFsStorage();
}
