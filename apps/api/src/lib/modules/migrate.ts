// SPDX-License-Identifier: Apache-2.0

/**
 * Core PGlite migration helper.
 *
 * Applies the core Drizzle migration journal against an embedded PGlite
 * database (Tier 0). PostgreSQL deployments use the standard
 * `drizzle-orm/postgres-js` migrator in `boot.ts`; this raw-SQL replay exists
 * because drizzle-kit's migrator does not target PGlite.
 *
 * Module-owned migrations no longer exist — modules' tables are centralized in
 * the core schema, so there is a single journal to apply here.
 */

import type { PGlite } from "@electric-sql/pglite";
import { logger } from "../logger.ts";

export async function applyCorePGliteMigrations(
  migrationsDir: string,
  pgClient?: PGlite,
): Promise<void> {
  const { join } = await import("node:path");

  const journalPath = join(migrationsDir, "meta/_journal.json");
  if (!(await Bun.file(journalPath).exists())) {
    logger.warn("No core migration journal found, skipping PGlite migrations");
    return;
  }

  const pg = pgClient ?? (await import("@appstrate/db/client")).getPGliteClient()!;

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)
    )
  `);

  const journal = JSON.parse(await Bun.file(journalPath).text()) as {
    entries: { idx: number; tag: string }[];
  };

  const { rows } = await pg.query<{ hash: string }>('SELECT hash FROM "__drizzle_migrations"');
  const applied = new Set(rows.map((r) => r.hash));

  let count = 0;
  for (const entry of journal.entries) {
    if (applied.has(entry.tag)) continue;

    const sqlFile = join(migrationsDir, `${entry.tag}.sql`);
    if (!(await Bun.file(sqlFile).exists())) {
      logger.warn("Core migration file not found, skipping", { tag: entry.tag });
      continue;
    }

    const content = await Bun.file(sqlFile).text();
    await pg.exec(content.replaceAll("--> statement-breakpoint", ""));
    await pg.query('INSERT INTO "__drizzle_migrations" (hash) VALUES ($1)', [entry.tag]);
    count++;
  }

  logger.info("PGlite core migrations applied", { count });
}
