// SPDX-License-Identifier: Apache-2.0

/**
 * Module migration helper — applies Drizzle migrations for built-in modules.
 *
 * Follows the cloud pattern: each module owns its own migration directory,
 * journal, and tracking table (`__drizzle_migrations_<moduleId>`).
 *
 * Supports both PostgreSQL (via drizzle-orm migrator) and PGlite (via raw SQL).
 */

import { isEmbeddedDb, reservePgConnection } from "@appstrate/db/client";
import type { PGlite } from "@electric-sql/pglite";
import { logger } from "../logger.ts";

/**
 * Apply Drizzle migrations for a module.
 *
 * Each module owns its own tracking table (`__drizzle_migrations_<moduleId>`),
 * with hyphens replaced by underscores so the identifier is a valid SQL name.
 *
 * @param moduleId - Module identifier (used for migration tracking table name)
 * @param migrationsDir - Absolute path to the module's migrations directory
 * @param opts.requireCoreTables - Optional list of core table names that MUST
 *   exist before the module migration runs. Modules that use backward FK
 *   references (`.references()` pointing at core tables) should declare them
 *   here so a broken boot order fails loudly instead of producing a cryptic
 *   Postgres error deep inside Drizzle.
 */
export async function applyModuleMigrations(
  moduleId: string,
  migrationsDir: string,
  opts: { requireCoreTables?: readonly string[] } = {},
): Promise<void> {
  const migrationsTable = `__drizzle_migrations_${moduleId.replace(/-/g, "_")}`;

  if (opts.requireCoreTables && opts.requireCoreTables.length > 0) {
    await assertCoreTablesExist(moduleId, opts.requireCoreTables);
  }

  if (isEmbeddedDb) {
    await applyPGliteMigrations(moduleId, migrationsDir, migrationsTable);
  } else {
    await applyPostgresMigrations(migrationsDir, migrationsTable);
  }
}

/**
 * Fail fast if any of the core tables a module depends on via backward FK
 * references are missing. Protects against a broken boot order where module
 * migrations would run before core migrations and produce an opaque FK error.
 *
 * Issues a single `information_schema.tables` lookup in the `public` schema
 * and compares the returned set against the declared requirements.
 */
async function assertCoreTablesExist(moduleId: string, tables: readonly string[]): Promise<void> {
  const unique = Array.from(new Set(tables));
  let found: Set<string>;

  if (isEmbeddedDb) {
    const { getPGliteClient } = await import("@appstrate/db/client");
    const pg = getPGliteClient();
    if (!pg) {
      throw new Error(
        `Module "${moduleId}": PGlite client is not initialized — cannot verify core tables.`,
      );
    }
    const { rows } = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [unique],
    );
    found = new Set(rows.map((r) => r.table_name));
  } else {
    const reserved = await reservePgConnection();
    if (!reserved) {
      throw new Error("reservePgConnection() returned null — expected PostgreSQL client");
    }
    const { sql: reservedSql, release } = reserved;
    try {
      const rows = await reservedSql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY(${unique}::text[])
      `;
      found = new Set(rows.map((r) => r.table_name));
    } finally {
      release();
    }
  }

  const missing = unique.filter((t) => !found.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Module "${moduleId}" requires core tables that do not exist: ${missing.join(", ")}. ` +
        `This usually means core migrations have not run yet — check the boot order.`,
    );
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
): Promise<void> {
  const { db } = await import("@appstrate/db/client");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { sql } = await import("drizzle-orm");

  // pg_advisory_lock is session-scoped — the unlock must target the exact
  // backend connection that held the lock, so both the lock and the unlock
  // run on a reserved postgres-js connection. The migrate() work itself can
  // run on any pooled connection: the held lock blocks concurrent replicas
  // regardless of which connection they use for the protected work.
  const reserved = await reservePgConnection();
  if (!reserved) {
    throw new Error("reservePgConnection() returned null — expected PostgreSQL client");
  }
  const { sql: reservedSql, release } = reserved;

  const lockKey = lockKeyForModule(migrationsTable);
  try {
    await reservedSql`SELECT pg_advisory_lock(${String(lockKey)}::bigint)`;
    try {
      // Suppress NOTICE messages ("already exists, skipping") during migrations
      await db.execute(sql`SET client_min_messages TO 'warning'`);
      try {
        // drizzle's PgDatabase accepts any schema generic, but our exported Db
        // is typed against the core schema — the migrator only issues raw SQL
        // and never reads the generic, so the widening cast is safe.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema generic widening for migrator
        await migrate(db as any, {
          migrationsFolder: migrationsDir,
          migrationsTable,
          migrationsSchema: "drizzle",
        });
      } finally {
        await db.execute(sql`SET client_min_messages TO 'notice'`);
      }
    } finally {
      await reservedSql`SELECT pg_advisory_unlock(${String(lockKey)}::bigint)`;
    }
  } finally {
    release();
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
