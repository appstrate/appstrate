// SPDX-License-Identifier: Apache-2.0

/**
 * Module migration helper — applies Drizzle migrations for built-in modules.
 *
 * Follows the cloud pattern: each module owns its own migration directory,
 * journal, and tracking table (`__drizzle_migrations_<moduleId>`).
 *
 * Supports both PostgreSQL (via drizzle-orm migrator) and PGlite (via raw SQL).
 */

import type { ModuleInitContext } from "@appstrate/core/module";
import { logger } from "../logger.ts";

/**
 * Apply Drizzle migrations for a module.
 *
 * @param ctx - Module init context (provides databaseUrl and isEmbeddedDb)
 * @param moduleId - Module identifier (used for migration tracking table name)
 * @param migrationsDir - Absolute path to the module's migrations directory
 */
export async function applyModuleMigrations(
  ctx: ModuleInitContext,
  moduleId: string,
  migrationsDir: string,
): Promise<void> {
  const migrationsTable = `__drizzle_migrations_${moduleId.replace(/-/g, "_")}`;

  if (ctx.isEmbeddedDb) {
    await applyPGliteMigrations(moduleId, migrationsDir, migrationsTable);
  } else if (ctx.databaseUrl) {
    await applyPostgresMigrations(ctx.databaseUrl, migrationsDir, migrationsTable);
  }
}

async function applyPostgresMigrations(
  _databaseUrl: string,
  migrationsDir: string,
  migrationsTable: string,
): Promise<void> {
  const { db } = await import("@appstrate/db/client");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db type is compatible but schema generic differs
  await migrate(db as any, {
    migrationsFolder: migrationsDir,
    migrationsTable,
    migrationsSchema: "drizzle",
  });
}

async function applyPGliteMigrations(
  moduleId: string,
  migrationsDir: string,
  migrationsTable: string,
): Promise<void> {
  const { join } = await import("node:path");
  const { readFileSync, existsSync } = await import("node:fs");
  const { getPGliteClient } = await import("@appstrate/db/client");

  const journalPath = join(migrationsDir, "meta/_journal.json");
  if (!existsSync(journalPath)) {
    logger.warn("No migration journal found for module, skipping", { module: moduleId });
    return;
  }

  const pg = getPGliteClient()!;

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
