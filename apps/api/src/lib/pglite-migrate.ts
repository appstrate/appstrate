// SPDX-License-Identifier: Apache-2.0

/**
 * Core PGlite migration helper.
 *
 * Applies the core Drizzle migration journal against an embedded PGlite
 * database (Tier 0). PostgreSQL deployments use the standard
 * `drizzle-orm/postgres-js` migrator in `boot.ts`; this raw-SQL replay exists
 * because drizzle-kit's migrator does not target PGlite.
 *
 * There is exactly one journal to apply: modules own no tables (their tables
 * live in the core schema), so nothing else contributes migrations.
 */

import type { PGlite } from "@electric-sql/pglite";
import { logger } from "./logger.ts";

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

    // The body and its tracking row go in ONE transaction, because that is what
    // the PostgreSQL path already does: drizzle's pg dialect runs the whole
    // pending batch and the `__drizzle_migrations` inserts inside a single
    // `session.transaction(...)`. As two separate round trips there is a window
    // where the DDL commits and the tracking row never lands, and the loop above
    // keys on the journal TAG alone — so the next boot sees the file as pending
    // and REPLAYS it. Tier 0 is a shipped deployment mode on personal hardware
    // (Raspberry Pi, NAS), where an unclean shutdown inside that window is not
    // theoretical.
    //
    // A replay is not a harmless no-op. `0040_config_into_input.sql` wraps every
    // `application_packages.input_settings` row unconditionally and deliberately
    // — its header explains why a shape-sniffing guard is unsound — so a second
    // pass nests each row again into
    // `{"values":{"values":…,"locked":[]},"locked":[]}`.
    //
    // Nothing in the journal forbids a transaction block: no CREATE INDEX
    // CONCURRENTLY, no VACUUM, no `ALTER TYPE … ADD VALUE`, and every `BEGIN` in
    // the checked-in SQL is PL/pgSQL inside a `DO $$ … $$` block, not
    // transaction control. The journal is already written on that assumption —
    // `0041_restore_squash_indexes.sql` rules CONCURRENTLY out precisely because
    // the batch runs inside one transaction, and the `SET LOCAL lock_timeout`
    // fences in 0039/0041 are no-ops outside one.
    await pg.transaction(async (tx) => {
      await tx.exec(content.replaceAll("--> statement-breakpoint", ""));
      await tx.query('INSERT INTO "__drizzle_migrations" (hash) VALUES ($1)', [entry.tag]);
    });
    count++;
  }

  logger.info("PGlite core migrations applied", { count });
}
