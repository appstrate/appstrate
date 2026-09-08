import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "../drizzle/schema.ts";

export type CloudDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The transaction handle `db.transaction(async (tx) => …)` yields. Named so the
 * billing primitives shared by the cursor sweep and the org-deletion drain can
 * accept a transaction they did not open themselves.
 */
export type CloudTx = Parameters<Parameters<CloudDb["transaction"]>[0]>[0];

let cloudDb: CloudDb | null = null;
let cloudSql: ReturnType<typeof postgres> | null = null;

export function getCloudDb(): CloudDb {
  if (!cloudDb) throw new Error("Cloud DB not initialized. Call init() on the cloud module first.");
  return cloudDb;
}

export function initCloudDb(databaseUrl: string): void {
  cloudSql = postgres(databaseUrl);
  cloudDb = drizzle(cloudSql, { schema });
}

/**
 * Close the cloud DB connection pool — called from the module's `shutdown()`.
 * Idempotent: a no-op when the DB was never initialized. Ends the underlying
 * `postgres.js` client so a graceful shutdown doesn't leak open sockets.
 */
export async function closeCloudDb(): Promise<void> {
  if (cloudSql) {
    await cloudSql.end();
    cloudSql = null;
    cloudDb = null;
  }
}

/**
 * Stable 64-bit key for the session-level advisory lock that serializes cloud
 * migrations. Arbitrary constant — only has to be unique within this database.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4827392010;

const PG_INSUFFICIENT_PRIVILEGE = "42501";

/** Serializes the existence check + `CREATE DATABASE` across replicas booting at once. */
const DATABASE_CREATE_ADVISORY_LOCK_KEY = 4827392011;

function pgErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

/**
 * Create the database `databaseUrl` names when it does not exist. Nothing else
 * knows cloud needs it: the OSS compose files provision only the platform
 * database, so a dev box boots against a server where `appstrate_cloud` was
 * never created. `CREATE DATABASE` cannot target the session's own database,
 * so this goes through the server's `postgres` maintenance database with the
 * same credentials.
 *
 * The existence check runs first so every boot after the first needs no
 * privilege beyond connecting; only a missing database reaches `CREATE
 * DATABASE`, and a role without `CREATEDB` gets an error naming the one-time
 * command. The check and the create sit under a session advisory lock because
 * two replicas creating concurrently do not get `duplicate_database` — the
 * loser hits a `unique_violation` on `pg_database` while the winner is still
 * in flight.
 */
async function ensureCloudDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name) throw new Error("CLOUD_DATABASE_URL names no database (empty path)");

  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = "/postgres";
  const sql = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    await sql`SELECT pg_advisory_lock(${DATABASE_CREATE_ADVISORY_LOCK_KEY})`;
    const [existing] = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (existing) return;
    try {
      await sql`CREATE DATABASE ${sql(name)}`;
    } catch (err) {
      if (pgErrorCode(err) === PG_INSUFFICIENT_PRIVILEGE) {
        throw new Error(
          `Cloud database "${name}" does not exist and role "${decodeURIComponent(url.username)}" ` +
            `lacks CREATEDB. Create it once with: createdb ${name}`,
          { cause: err },
        );
      }
      throw err;
    }
  } finally {
    // Closing the session releases the advisory lock.
    await sql.end();
  }
}

/**
 * Apply cloud's own migrations against `CLOUD_DATABASE_URL`, creating the
 * database first when it does not exist yet (`ensureCloudDatabase`). Cloud owns
 * its database, so it runs its own migrator (a dedicated `postgres.js`
 * connection with `max: 1`). The module contract offers no migration hook — the
 * platform's boot pipeline migrates the platform schema only — so this is the
 * whole of cloud's schema management. Idempotent: the drizzle journal skips
 * already-applied migrations.
 *
 * Wrapped in a session-level `pg_advisory_lock` so concurrent boots (rolling /
 * multi-replica deploys) serialize: the first replica migrates while the others
 * block, then each acquires the lock and finds the journal already applied (a
 * no-op). Without the lock, two replicas could run migration `0000`
 * simultaneously and one would crash at boot ("relation already exists").
 */
export async function migrateCloudDb(databaseUrl: string): Promise<void> {
  await ensureCloudDatabase(databaseUrl);
  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../drizzle/migrations",
  );
  // max: 1 — the lock and the migration must run on the SAME connection for the
  // session-level advisory lock to guard the migration.
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
    try {
      await migrate(drizzle(sql, { schema }), { migrationsFolder });
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`.catch(() => {});
    }
  } finally {
    // Closing the session also releases any still-held advisory lock.
    await sql.end();
  }
}
