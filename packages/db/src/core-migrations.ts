// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's core migrations, applied or verified against a PostgreSQL URL.
 *
 * Deliberately free of `./client.ts` and of `getEnv()`: the standalone migrator
 * (`migrate.ts`, the compose `appstrate-migrate` service) runs in a container that
 * carries `DATABASE_URL` and nothing else, and the application's boot calls the same
 * functions on PostgreSQL (PGlite keeps `apps/api/src/lib/pglite-migrate.ts`). One
 * implementation, so "apply" and "verify" cannot disagree about what is pending.
 *
 * Scope: the core journal (`drizzle.__drizzle_migrations`) only. `@appstrate/module-ee`
 * keeps its own journal (`drizzle.ee_migrations`) and applies it itself at `init()`.
 */

import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Absolute path of the core migration folder (SQL files + `meta/_journal.json`). */
export const CORE_MIGRATIONS_FOLDER = resolve(import.meta.dir, "../drizzle");

/**
 * Key of the session-level advisory lock that serializes core migrations.
 *
 * Drizzle's migrator takes no lock of its own: it reads the journal BEFORE opening its
 * transaction, so two runners starting together (several app replicas, or a replica
 * beside the `appstrate-migrate` service) both read the same watermark and both try to
 * apply the same files — the loser crashes with "relation already exists". Holding this
 * lock around the migrator makes the second runner wait, then find nothing pending.
 * Arbitrary constant; it only has to be unique within the database.
 */
const CORE_MIGRATION_LOCK_KEY = 7246811234567890n;

/** Journal location. Matches drizzle's defaults, which the migrator is called with. */
const JOURNAL_TABLE = "drizzle.__drizzle_migrations";

/** Most tags named in `assertCoreMigrationsApplied`'s message. */
const MAX_TAGS_LISTED = 10;

/**
 * Apply every pending core migration.
 *
 * A dedicated `max: 1` client: the advisory lock is per SESSION, so the lock and the
 * migration must run on the one connection (a pool would hand the migrator a different
 * one and the lock would guard nothing). `onnotice` is silenced: on an up-to-date
 * database the migrator's `IF NOT EXISTS` statements raise a notice on every boot.
 */
export async function applyCoreMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await client`SELECT pg_advisory_lock(${String(CORE_MIGRATION_LOCK_KEY)}::bigint)`;
    try {
      await migrate(drizzle(client), { migrationsFolder: CORE_MIGRATIONS_FOLDER });
    } finally {
      await client`SELECT pg_advisory_unlock(${String(CORE_MIGRATION_LOCK_KEY)}::bigint)`.catch(
        () => {},
      );
    }
  } finally {
    // Ending the session also releases the lock if the unlock above failed.
    await client.end();
  }
}

interface JournalEntry {
  tag: string;
  when: number;
}

async function readJournal(): Promise<JournalEntry[]> {
  const journal = (await Bun.file(
    resolve(CORE_MIGRATIONS_FOLDER, "meta/_journal.json"),
  ).json()) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/**
 * Tags, in journal order, that `applyCoreMigrations` would run now. Read-only, no lock.
 *
 * Same rule as drizzle's migrator, which decides by WATERMARK and not by file:
 * a migration is applied when its journal `when` (`folderMillis`) is greater than
 * the `created_at` of the LAST journal row, read as drizzle reads it
 * (`ORDER BY created_at DESC LIMIT 1`; Postgres sorts NULL first in DESC, so a NULL row
 * makes everything pending, as for the migrator, where `max()` would ignore it) — see
 * `node_modules/drizzle-orm/pg-core/dialect.js`,
 * `PgDialect.migrate` (`lastDbMigration.created_at < migration.folderMillis`), with
 * `folderMillis` set from `journalEntry.when` in `drizzle-orm/migrator.js`. Mirroring it
 * means a database AHEAD of the code (a rollback) reports nothing pending, exactly as
 * the migrator would do nothing. A missing journal table means a fresh database: every
 * tag is pending.
 */
export async function listPendingCoreMigrations(databaseUrl: string): Promise<string[]> {
  const entries = await readJournal();
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [probe] = await client<{ exists: boolean }[]>`
      SELECT to_regclass(${JOURNAL_TABLE}) IS NOT NULL AS exists`;
    if (!probe?.exists) return entries.map((e) => e.tag);
    const [row] = await client<{ watermark: string | null }[]>`
      SELECT created_at::text AS watermark FROM drizzle."__drizzle_migrations"
      ORDER BY created_at DESC LIMIT 1`;
    const watermark = row?.watermark ?? null;
    if (watermark === null) return entries.map((e) => e.tag);
    const applied = Number(watermark);
    return entries.filter((e) => e.when > applied).map((e) => e.tag);
  } finally {
    await client.end();
  }
}

/**
 * Throw unless every core migration is applied. The boot's `verify` mode: an
 * application that did not migrate refuses to run against a schema older than its code.
 */
export async function assertCoreMigrationsApplied(databaseUrl: string): Promise<void> {
  const pending = await listPendingCoreMigrations(databaseUrl);
  if (pending.length === 0) return;
  const listed = pending.slice(0, MAX_TAGS_LISTED).join(", ");
  const more =
    pending.length > MAX_TAGS_LISTED ? `, … and ${pending.length - MAX_TAGS_LISTED} more` : "";
  throw new Error(
    `${pending.length} core migration(s) not applied to this database: ${listed}${more}. ` +
      "Apply them by running `bun packages/db/src/migrate.ts` with this DATABASE_URL " +
      "(the compose `appstrate-migrate` service does exactly that), or set " +
      "MIGRATIONS_ON_BOOT=apply to let the application migrate at boot. " +
      "This check covers the core journal only: @appstrate/module-ee's own journal is " +
      "not verified here, the module applies it itself at init.",
  );
}
