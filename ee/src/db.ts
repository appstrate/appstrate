// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "../drizzle/schema.ts";

export type EeDb = ReturnType<typeof drizzle<typeof schema>>;

/** `onnotice`: postgres.js prints NOTICEs to stdout; `max`: a small pool beside the platform's. */
const POOL_OPTIONS = { max: 5, onnotice: () => {} } as const;

/** Arbitrary, distinct from the platform's and module-ee's: serializes concurrent boots. */
const MIGRATION_LOCK_KEY = 5038120741;

let sqlClient: ReturnType<typeof postgres> | null = null;
let eeDb: EeDb | null = null;

export function getEeDb(): EeDb {
  if (!eeDb) throw new Error("@appstrate/ee is not initialized: init() opens its database.");
  return eeDb;
}

/**
 * Apply this package's migrations to the platform database, under the journal
 * `drizzle.appstrate_ee_migrations` (the platform's and module-ee's are
 * untouched; the object sets are disjoint), then open the pool. A session-level
 * advisory lock on the migrating connection serializes replicas booting at
 * once. Idempotent.
 */
export async function openEeDb(databaseUrl: string): Promise<void> {
  if (eeDb) return;
  const migrator = postgres(databaseUrl, { ...POOL_OPTIONS, max: 1 });
  try {
    await migrator`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(migrator, { schema }), {
        migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle/migrations"),
        migrationsTable: "appstrate_ee_migrations",
        migrationsSchema: "drizzle",
      });
    } finally {
      await migrator`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => {});
    }
  } finally {
    await migrator.end();
  }
  sqlClient = postgres(databaseUrl, POOL_OPTIONS);
  eeDb = drizzle(sqlClient, { schema });
}

export async function closeEeDb(): Promise<void> {
  if (!sqlClient) return;
  await sqlClient.end();
  sqlClient = null;
  eeDb = null;
}
