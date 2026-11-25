// SPDX-License-Identifier: Apache-2.0

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "../drizzle/schema.ts";

export type BillingDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The transaction handle `db.transaction(async (tx) => …)` yields. Named so the
 * billing primitives shared by the cursor sweep and the org-deletion drain can
 * accept a transaction they did not open themselves.
 */
export type BillingTx = Parameters<Parameters<BillingDb["transaction"]>[0]>[0];

let billingDb: BillingDb | null = null;
let billingSql: ReturnType<typeof postgres> | null = null;
let billingDatabaseUrl: string | null = null;

/**
 * Connection options shared by the module's pool and its migrator. `onnotice`:
 * postgres.js prints server NOTICEs to stdout, bypassing the platform's JSON logger.
 * `max`: without one, postgres.js opens up to ten connections per replica on the
 * PLATFORM database, beside the platform's own pool.
 */
const POOL_OPTIONS = { max: 5, onnotice: () => {} } as const;

export function getBillingDb(): BillingDb {
  if (!billingDb)
    throw new Error("Billing DB not initialized. Call init() on the billing module first.");
  return billingDb;
}

/**
 * Open this module's pool on the PLATFORM database (`DATABASE_URL`). The `ee_*`
 * tables sit beside the platform's own, under their own journal — see
 * {@link migrateBillingDb}. It is still a pool of its own rather than the platform's:
 * the module reads platform rows through `ctx.services`, and sharing the handle
 * (for an atomic org deletion, say) is a contract change, not a connection one.
 *
 * Idempotent: a second call for the same URL keeps the open pool; a call for a DIFFERENT
 * one throws, since replacing the handle strands the first pool's sockets.
 */
export function initBillingDb(databaseUrl: string): void {
  if (billingSql) {
    if (databaseUrl !== billingDatabaseUrl) {
      throw new Error(
        "initBillingDb called with a different DATABASE_URL than the open pool. A process serves one " +
          "platform database; re-pointing it would leave the previous pool open and unreachable.",
      );
    }
    return;
  }
  billingSql = postgres(databaseUrl, POOL_OPTIONS);
  billingDb = drizzle(billingSql, { schema });
  billingDatabaseUrl = databaseUrl;
}

/**
 * Close the billing DB connection pool — called from the module's `shutdown()`.
 * Idempotent: a no-op when the DB was never initialized. Ends the underlying
 * `postgres.js` client so a graceful shutdown doesn't leak open sockets.
 */
export async function closeBillingDb(): Promise<void> {
  if (billingSql) {
    await billingSql.end();
    billingSql = null;
    billingDb = null;
    billingDatabaseUrl = null;
  }
}

/**
 * Stable 64-bit key for the session-level advisory lock that serializes the billing module
 * migrations. Arbitrary constant — only has to be unique within this database.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4827392010;

/**
 * Apply the billing module's own migrations against the platform database.
 *
 * Two journals, one database: both `migrationsSchema` and `migrationsTable` are
 * stated below, and `drizzle/drizzle.config.ts` states the same pair, so the two
 * are literally comparable. The schema is the one the platform's own migrator
 * writes to, so the TABLE name is what keeps the chains apart —
 * `drizzle.ee_migrations` here, `drizzle.__drizzle_migrations` there. The module
 * contract offers no migration hook (the platform's boot pipeline migrates the
 * platform schema only), so this is the whole of the billing module's schema management.
 * Idempotent: the journal skips already-applied migrations.
 *
 * Wrapped in a session-level `pg_advisory_lock` so concurrent boots (rolling /
 * multi-replica deploys) serialize: the first replica migrates while the others
 * block, then each acquires the lock and finds the journal already applied (a
 * no-op). Drizzle's migrator takes no lock of its own — it reads the journal
 * BEFORE opening its transaction — so without this, two replicas would both
 * read an empty journal and one would crash at boot ("relation already exists").
 * Core and billing use separate locks and journals. Core migrations create the shared
 * drizzle schema before billing initializes.
 */
export async function migrateBillingDb(databaseUrl: string): Promise<void> {
  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../drizzle/migrations",
  );
  // max: 1 — the lock and the migration must run on the SAME connection for the
  // session-level advisory lock to guard the migration. Everything else is the pool's
  // own options, so a setting added there reaches the migrator too.
  const sqlClient = postgres(databaseUrl, { ...POOL_OPTIONS, max: 1 });
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
