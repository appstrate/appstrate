// SPDX-License-Identifier: Apache-2.0

/**
 * Module migration helper — applies Drizzle migrations for built-in modules.
 *
 * Follows the cloud pattern: each module owns its own migration directory,
 * journal, and tracking table (`__drizzle_migrations_<moduleId>`).
 *
 * Supports both PostgreSQL (via drizzle-orm migrator) and PGlite (via raw SQL).
 */

import { isEmbeddedDb } from "@appstrate/db/client";
import type { Db } from "@appstrate/db/client";
import type { PGlite } from "@electric-sql/pglite";
import type { ModuleInitContext } from "@appstrate/core/module";
import { logger } from "../logger.ts";

/**
 * Apply Drizzle migrations for a module.
 *
 * `ctx` is accepted for contract symmetry with the module init signature but
 * not read — the migrator targets the shared `db` client from @appstrate/db
 * regardless of whether `ctx.databaseUrl` is set.
 *
 * @param _ctx - Module init context (unused, kept for API symmetry)
 * @param moduleId - Module identifier (used for migration tracking table name)
 * @param migrationsDir - Absolute path to the module's migrations directory
 */
export async function applyModuleMigrations(
  _ctx: ModuleInitContext,
  moduleId: string,
  migrationsDir: string,
): Promise<void> {
  const migrationsTable = `__drizzle_migrations_${moduleId.replace(/-/g, "_")}`;

  if (isEmbeddedDb) {
    await applyPGliteMigrations(moduleId, migrationsDir, migrationsTable);
  } else {
    await applyPostgresMigrations(migrationsDir, migrationsTable);
  }
}

/**
 * Derive a stable 64-bit advisory lock key from the module's tracking table
 * name. The hash is deterministic across replicas so multiple replicas starting
 * simultaneously contend on the same lock for the same module, but different
 * modules use different keys and can migrate in parallel.
 */
export function lockKeyForModule(migrationsTable: string): bigint {
  // FNV-1a 64-bit over the UTF-8 bytes of the table name.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < migrationsTable.length; i++) {
    hash ^= BigInt(migrationsTable.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  // Fold unsigned 64-bit into signed bigint range expected by pg_advisory_lock
  return hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
}

export async function applyPostgresMigrations(
  migrationsDir: string,
  migrationsTable: string,
  dbClient?: Db,
): Promise<void> {
  const db = dbClient ?? (await import("@appstrate/db/client")).db;
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { sql } = await import("drizzle-orm");

  // Serialize concurrent replicas on the same module's migration table.
  const lockKey = lockKeyForModule(migrationsTable);
  await db.execute(sql`SELECT pg_advisory_lock(${lockKey}::bigint)`);
  try {
    // Suppress NOTICE messages ("already exists, skipping") during migrations
    await db.execute(sql`SET client_min_messages TO 'warning'`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db type is compatible but schema generic differs
      await migrate(db as any, {
        migrationsFolder: migrationsDir,
        migrationsTable,
        migrationsSchema: "drizzle",
      });
    } finally {
      await db.execute(sql`SET client_min_messages TO 'notice'`);
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${lockKey}::bigint)`);
  }
}

export async function applyPGliteMigrations(
  moduleId: string,
  migrationsDir: string,
  migrationsTable: string,
  pgClient?: PGlite,
): Promise<void> {
  const { join } = await import("node:path");
  const { readFileSync, existsSync } = await import("node:fs");

  const journalPath = join(migrationsDir, "meta/_journal.json");
  if (!existsSync(journalPath)) {
    logger.warn("No migration journal found for module, skipping", { module: moduleId });
    return;
  }

  const pg = pgClient ?? (await import("@appstrate/db/client")).getPGliteClient()!;

  // Create module-specific migrations tracking table
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "${migrationsTable}" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)
    )
  `);

  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: { idx: number; tag: string }[];
  };

  const { rows } = await pg.query<{ hash: string }>(`SELECT hash FROM "${migrationsTable}"`);
  const applied = new Set(rows.map((r) => r.hash));

  let count = 0;
  for (const entry of journal.entries) {
    if (applied.has(entry.tag)) continue;

    const sqlFile = join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(sqlFile)) {
      logger.warn("Module migration file not found, skipping", {
        module: moduleId,
        tag: entry.tag,
      });
      continue;
    }

    const content = readFileSync(sqlFile, "utf-8");
    await pg.exec(content.replaceAll("--> statement-breakpoint", ""));
    await pg.query(`INSERT INTO "${migrationsTable}" (hash) VALUES ($1)`, [entry.tag]);
    count++;
  }

  if (count > 0) {
    logger.info("Module migrations applied", { module: moduleId, count });
  }
}
