// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's core migrations on PostgreSQL, shared by the boot and by the standalone
 * migrator (`migrate.ts`). Free of `./client.ts` and `getEnv()`: the migrate container carries
 * `DATABASE_URL` and nothing else. Core journal only; `@appstrate/module-ee` applies its own.
 */

import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Absolute path of the core migration folder (SQL files + `meta/_journal.json`). */
export const CORE_MIGRATIONS_FOLDER = resolve(import.meta.dir, "../drizzle");

/**
 * Session-level advisory lock serializing core migrations. Drizzle's migrator reads the
 * journal before opening its transaction, so two runners starting together would apply the
 * same files and the loser would crash. Arbitrary value, unique within the database.
 */
const CORE_MIGRATION_LOCK_KEY = 7246811234567890n;

/** Drizzle's default journal table. */
const JOURNAL_TABLE = "drizzle.__drizzle_migrations";

/** Most tags named in `assertCoreMigrationsApplied`'s message. */
const MAX_TAGS_LISTED = 10;

/**
 * Apply every pending core migration. `max: 1`: the lock is per session, so lock and migration
 * must share one connection. `onnotice` silences the migrator's `IF NOT EXISTS` notices.
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
    // Also releases the lock if the unlock above failed.
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
 * Drizzle's own rule (`PgDialect.migrate`): a watermark, not a per-file check. A migration
 * is pending when its journal `when` is greater than the `created_at` of the last journal
 * row (`ORDER BY created_at DESC LIMIT 1`, NULL first). So a database ahead of the code
 * reports nothing pending, and a missing journal table reports everything.
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

/** Throw unless every core migration is applied (the boot's `verify` mode). */
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
