import { afterAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { migrateCloudDb } from "../../../src/db.ts";
import { getCloudEnv } from "../../../src/env.ts";

// Fresh names so this file never touches the shared `cloud_test` database.
const FRESH_DB = "cloud_test_autocreate";
const NO_CREATEDB_ROLE = "cloud_test_nocreatedb";
const NO_CREATEDB_DB = "cloud_test_nocreatedb_db";

function withDatabase(url: string, name: string, user?: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  if (user) {
    u.username = user;
    u.password = "x";
  }
  return u.toString();
}

const baseUrl = getCloudEnv().CLOUD_DATABASE_URL;
const admin = postgres(baseUrl, { max: 1 });

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH_DB}`);
  await admin.unsafe(`DROP DATABASE IF EXISTS ${NO_CREATEDB_DB}`);
  await admin.unsafe(`DROP ROLE IF EXISTS ${NO_CREATEDB_ROLE}`);
  await admin.end();
});

describe("migrateCloudDb on a server where the cloud database does not exist", () => {
  it("creates the database, then migrates it", async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH_DB}`);

    await migrateCloudDb(withDatabase(baseUrl, FRESH_DB));

    const [row] = await admin`SELECT 1 AS ok FROM pg_database WHERE datname = ${FRESH_DB}`;
    expect(row?.ok).toBe(1);

    const fresh = postgres(withDatabase(baseUrl, FRESH_DB), { max: 1 });
    try {
      const [{ count }] = await fresh`SELECT count(*)::int AS count FROM cloud_billing_accounts`;
      expect(count).toBe(0);
    } finally {
      await fresh.end();
    }

    // Second boot: the database exists, the migrator finds the journal applied.
    await expect(migrateCloudDb(withDatabase(baseUrl, FRESH_DB))).resolves.toBeUndefined();
  });

  it("serializes replicas booting concurrently against the missing database", async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH_DB}`);
    const url = withDatabase(baseUrl, FRESH_DB);

    // Without the advisory lock the losers fail with unique_violation (23505)
    // on pg_database — CREATE DATABASE raced, not duplicate_database.
    await expect(
      Promise.all([migrateCloudDb(url), migrateCloudDb(url), migrateCloudDb(url)]),
    ).resolves.toHaveLength(3);
  });

  it("names the one-time createdb command when the role lacks CREATEDB", async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${NO_CREATEDB_DB}`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${NO_CREATEDB_ROLE}`);
    await admin.unsafe(`CREATE ROLE ${NO_CREATEDB_ROLE} LOGIN PASSWORD 'x' NOCREATEDB`);

    await expect(
      migrateCloudDb(withDatabase(baseUrl, NO_CREATEDB_DB, NO_CREATEDB_ROLE)),
    ).rejects.toThrow(`lacks CREATEDB. Create it once with: createdb ${NO_CREATEDB_DB}`);

    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${NO_CREATEDB_DB}`;
    expect(rows).toHaveLength(0);
  });
});
