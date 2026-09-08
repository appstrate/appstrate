// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "../drizzle/schema.ts";

export type EeDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The transaction handle `db.transaction(async (tx) => …)` yields. Named so the
 * billing primitives shared by the cursor sweep and the org-deletion drain can
 * accept a transaction they did not open themselves.
 */
export type EeTx = Parameters<Parameters<EeDb["transaction"]>[0]>[0];

let eeDb: EeDb | null = null;
let eeSql: ReturnType<typeof postgres> | null = null;

export function getEeDb(): EeDb {
  if (!eeDb) throw new Error("EE DB not initialized. Call init() on the EE module first.");
  return eeDb;
}

/**
 * Open this module's pool on the PLATFORM database (`DATABASE_URL`). The `ee_*`
 * tables sit beside the platform's own, under their own journal — see
 * {@link migrateEeDb}. It is still a pool of its own rather than the platform's:
 * the module reads platform rows through `ctx.services`, and sharing the handle
 * (for an atomic org deletion, say) is a contract change, not a connection one.
 */
export function initEeDb(databaseUrl: string): void {
  eeSql = postgres(databaseUrl);
  eeDb = drizzle(eeSql, { schema });
}

/**
 * Close the EE DB connection pool — called from the module's `shutdown()`.
 * Idempotent: a no-op when the DB was never initialized. Ends the underlying
 * `postgres.js` client so a graceful shutdown doesn't leak open sockets.
 */
export async function closeEeDb(): Promise<void> {
  if (eeSql) {
    await eeSql.end();
    eeSql = null;
    eeDb = null;
  }
}

/**
 * Stable 64-bit key for the session-level advisory lock that serializes EE
 * migrations. Arbitrary constant — only has to be unique within this database.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4827392010;

/**
 * Apply EE's own migrations against the platform database.
 *
 * Two journals, one database: both `migrationsSchema` and `migrationsTable` are
 * stated below, and `drizzle/drizzle.config.ts` states the same pair, so the two
 * are literally comparable. The schema is the one the platform's own migrator
 * writes to, so the TABLE name is what keeps the chains apart —
 * `drizzle.ee_migrations` here, `drizzle.__drizzle_migrations` there. The module
 * contract offers no migration hook (the platform's boot pipeline migrates the
 * platform schema only), so this is the whole of EE's schema management.
 * Idempotent: the journal skips already-applied migrations.
 *
 * Wrapped in a session-level `pg_advisory_lock` so concurrent boots (rolling /
 * multi-replica deploys) serialize: the first replica migrates while the others
 * block, then each acquires the lock and finds the journal already applied (a
 * no-op). Drizzle's migrator takes no lock of its own — it reads the journal
 * BEFORE opening its transaction — so without this, two replicas would both
 * read an empty journal and one would crash at boot ("relation already exists").
 * The lock does NOT serialize this migrator against the PLATFORM's, which runs
 * unserialised in the same database: the two are safe only because their object
 * sets are disjoint, `CREATE SCHEMA IF NOT EXISTS drizzle` being the one
 * statement they share and the core migrator committing it first.
 */
export async function migrateEeDb(databaseUrl: string): Promise<void> {
  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../drizzle/migrations",
  );
  // max: 1 — the lock and the migration must run on the SAME connection for the
  // session-level advisory lock to guard the migration.
  // `onnotice`: postgres.js prints server notices to stdout by default, and the
  // migrator's `CREATE SCHEMA IF NOT EXISTS` raises one on every boot.
  const sqlClient = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sqlClient`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
    try {
      await migrate(drizzle(sqlClient, { schema }), {
        migrationsFolder,
        migrationsTable: "ee_migrations",
        migrationsSchema: "drizzle",
      });
    } finally {
      await sqlClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`.catch(() => {});
    }
  } finally {
    // Closing the session also releases any still-held advisory lock.
    await sqlClient.end();
  }
}
