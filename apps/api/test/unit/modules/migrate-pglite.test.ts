import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyPGliteMigrations } from "../../../src/lib/modules/migrate.ts";

const FIXTURE_ROOT = resolve(import.meta.dir, "../../fixtures/migrations");
const FIXTURE_A = resolve(FIXTURE_ROOT, "test-module");

describe("applyPGliteMigrations", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.waitReady;
  });

  afterEach(async () => {
    await pg.close();
  });

  it("creates the module table and tracks the applied migration on first run", async () => {
    await applyPGliteMigrations("test-module", FIXTURE_A, "__drizzle_migrations_test_module", pg);

    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'test_migrate_dummy'`,
    );
    expect(tables.rows.length).toBe(1);

    const tracked = await pg.query<{ hash: string }>(
      `SELECT hash FROM "__drizzle_migrations_test_module"`,
    );
    expect(tracked.rows.length).toBe(1);
    expect(tracked.rows[0]?.hash).toBe("0000_init");
  });

  it("is idempotent — second call does not re-apply migrations", async () => {
    await applyPGliteMigrations("test-module", FIXTURE_A, "__drizzle_migrations_test_module", pg);
    await applyPGliteMigrations("test-module", FIXTURE_A, "__drizzle_migrations_test_module", pg);

    const tracked = await pg.query<{ hash: string }>(
      `SELECT hash FROM "__drizzle_migrations_test_module"`,
    );
    expect(tracked.rows.length).toBe(1);
  });

  it("skips gracefully when the journal file is missing", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "migrate-no-journal-"));
    try {
      // No throw expected — logger.warn is emitted but the call resolves cleanly.
      await applyPGliteMigrations(
        "empty-module",
        emptyDir,
        "__drizzle_migrations_empty_module",
        pg,
      );

      // The tracking table should NOT be created when the journal is missing.
      const tables = await pg.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name = '__drizzle_migrations_empty_module'`,
      );
      expect(tables.rows.length).toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("skips individual migrations whose SQL file is missing", async () => {
    const brokenDir = mkdtempSync(join(tmpdir(), "migrate-missing-sql-"));
    try {
      mkdirSync(join(brokenDir, "meta"));
      writeFileSync(
        join(brokenDir, "meta/_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [{ idx: 0, version: "7", when: 0, tag: "0000_missing", breakpoints: true }],
        }),
      );
      // Note: no 0000_missing.sql file on disk.

      await applyPGliteMigrations(
        "broken-module",
        brokenDir,
        "__drizzle_migrations_broken_module",
        pg,
      );

      // Tracking table is created, but no entries are inserted since the SQL was absent.
      const tracked = await pg.query<{ hash: string }>(
        `SELECT hash FROM "__drizzle_migrations_broken_module"`,
      );
      expect(tracked.rows.length).toBe(0);
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
  });
});
