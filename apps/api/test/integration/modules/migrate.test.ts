import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../../helpers/db.ts";
import { applyModuleMigrations } from "../../../src/lib/modules/migrate.ts";

const FIXTURE_ROOT = resolve(import.meta.dir, "../../fixtures/migrations");
const FIXTURE_A = resolve(FIXTURE_ROOT, "test-module");
const FIXTURE_B = resolve(FIXTURE_ROOT, "test-module-2");

async function cleanup() {
  // Suppress NOTICE spam from DROP ... IF EXISTS on absent tables.
  await db.execute(sql`SET client_min_messages TO 'warning'`);
  try {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "test_migrate_dummy"`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "test_migrate_dummy_2"`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS drizzle.__drizzle_migrations_test_module`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS drizzle.__drizzle_migrations_test_module_2`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS drizzle.__drizzle_migrations_my_module`));
  } finally {
    await db.execute(sql`SET client_min_messages TO 'notice'`);
  }
}

async function tableExists(name: string): Promise<boolean> {
  const res = (await db.execute(
    sql`SELECT 1 FROM information_schema.tables WHERE table_name = ${name} LIMIT 1`,
  )) as unknown as unknown[];
  return res.length > 0;
}

async function countRows(fullyQualified: string): Promise<number> {
  const res = (await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM ${fullyQualified}`),
  )) as unknown as { n: number }[];
  return Number(res[0]?.n ?? 0);
}

describe("applyModuleMigrations (Postgres)", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates the module table and tracks the applied migration on first run", async () => {
    await applyModuleMigrations("test-module", FIXTURE_A);

    expect(await tableExists("test_migrate_dummy")).toBe(true);
    expect(await countRows('drizzle."__drizzle_migrations_test_module"')).toBe(1);
  });

  it("replaces hyphens with underscores in the tracking table name", async () => {
    await applyModuleMigrations("my-module", FIXTURE_A);

    // Hyphen → underscore: "my-module" becomes "__drizzle_migrations_my_module"
    const res = (await db.execute(
      sql`SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'drizzle'
          AND table_name = '__drizzle_migrations_my_module'
          LIMIT 1`,
    )) as unknown as unknown[];
    expect(res.length).toBe(1);
  });

  // Guards the pool-affinity fix: reserveDrizzleDb pins the advisory lock, the
  // migrator, and the unlock to the same connection. Before the fix, the unlock
  // would land on a different pool connection (silent no-op) and the second
  // call would block forever waiting for the now-orphaned lock.
  it("is idempotent across successive calls on the same module", async () => {
    await applyModuleMigrations("test-module", FIXTURE_A);
    await applyModuleMigrations("test-module", FIXTURE_A);
    await applyModuleMigrations("test-module", FIXTURE_A);

    expect(await countRows('drizzle."__drizzle_migrations_test_module"')).toBe(1);
  });

  it("isolates migrations between modules (separate tracking tables)", async () => {
    await applyModuleMigrations("test-module", FIXTURE_A);
    await applyModuleMigrations("test-module-2", FIXTURE_B);

    expect(await tableExists("test_migrate_dummy")).toBe(true);
    expect(await tableExists("test_migrate_dummy_2")).toBe(true);
    expect(await countRows('drizzle."__drizzle_migrations_test_module"')).toBe(1);
    expect(await countRows('drizzle."__drizzle_migrations_test_module_2"')).toBe(1);
  });
});
