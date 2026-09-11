// SPDX-License-Identifier: Apache-2.0

/**
 * `applyCorePGliteMigrations` — a migration's body and its `__drizzle_migrations`
 * row must land together or not at all.
 *
 * The tier-0 runner keys on the journal TAG (`pglite-migrate.ts`), so a file
 * whose DDL committed but whose tracking row did not is indistinguishable from
 * a file that never ran: the next boot replays it. That is the whole hazard —
 * `0040_config_into_input.sql` wraps every `space_packages.input_settings`
 * row unconditionally, so a replay nests each row a second time into
 * `{"values":{"values":…,"locked":[]},"locked":[]}` and the configured values
 * are gone. Tier 0 ships for "personal use, small devices (Raspberry Pi 4+,
 * NAS)" (README), where a crash between two round trips is a normal Tuesday.
 *
 * The failure is injected through the `pgClient` parameter that already exists
 * for tests — the database is REAL PGlite, only the bookkeeping INSERT is made
 * to throw. Nothing here mocks the migration itself: the body is a plain
 * `CREATE TABLE` in a throwaway journal, and its presence afterwards is the
 * assertion.
 *
 * Deliberately its own throwaway journal rather than the real one in
 * `packages/db/drizzle`: the real chain is already replayed end-to-end by
 * `migration-index-parity.test.ts`, which is what proves the transaction
 * wrapper accepts all 47 files. This file proves the rollback.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyCorePGliteMigrations } from "../../src/lib/pglite-migrate.ts";

/** Created by the throwaway migration below; its survival IS the defect. */
const BODY_TABLE = "pglite_atomicity_probe";

/** Thrown in place of "the process died between the two statements". */
class BookkeepingFailure extends Error {}

/** A one-entry journal whose only migration creates `BODY_TABLE`. */
async function makeMigrationsDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pglite-migrate-atomicity-"));
  const entry = { idx: 0, version: "7", when: 0, tag: "0000_probe", breakpoints: true };
  // `Bun.write` creates `meta/` on the way.
  await Bun.write(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [entry] }),
  );
  await Bun.write(join(dir, "0000_probe.sql"), `CREATE TABLE "${BODY_TABLE}" ("id" integer);`);
  return dir;
}

/**
 * The real PGlite, with the bookkeeping INSERT — and only that statement —
 * failing, whether the runner sends it on its own connection or inside a
 * transaction. Both paths are guarded on purpose: that is what makes this a
 * negative control for the transaction wrapper rather than for the fake.
 *
 * Cast because only `exec` / `query` / `transaction` are ever reached; widening
 * the production signature to a hand-written structural type would be a second
 * definition of PGlite free to disagree with the real one.
 */
function clientThatFailsBookkeeping(pg: PGlite): PGlite {
  const guard = <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    if (sql.includes('INSERT INTO "__drizzle_migrations"')) {
      throw new BookkeepingFailure("bookkeeping INSERT failed");
    }
    return run();
  };
  const client = {
    exec: (sql: string) => pg.exec(sql),
    query: (sql: string, params?: unknown[]) => guard(sql, () => pg.query(sql, params)),
    transaction: <T>(
      callback: (tx: {
        exec: (sql: string) => Promise<unknown>;
        query: (sql: string, params?: unknown[]) => Promise<unknown>;
      }) => Promise<T>,
    ) =>
      pg.transaction((tx) =>
        callback({
          exec: (sql: string) => tx.exec(sql),
          query: (sql: string, params?: unknown[]) => guard(sql, () => tx.query(sql, params)),
        }),
      ),
  };
  return client as unknown as PGlite;
}

async function tableExists(pg: PGlite, name: string): Promise<boolean> {
  const { rows } = await pg.query<{ reg: string | null }>("SELECT to_regclass($1) AS reg", [name]);
  return rows[0]?.reg != null;
}

async function appliedTags(pg: PGlite): Promise<string[]> {
  const { rows } = await pg.query<{ hash: string }>('SELECT hash FROM "__drizzle_migrations"');
  return rows.map((row) => row.hash);
}

/** Runs `body` against a fresh in-memory PGlite + a fresh throwaway journal. */
async function withHarness(body: (pg: PGlite, dir: string) => Promise<void>): Promise<void> {
  const dir = await makeMigrationsDir();
  const pg = new PGlite();
  try {
    await body(pg, dir);
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("applyCorePGliteMigrations atomicity", () => {
  it("rolls the migration body back when the bookkeeping INSERT fails", async () => {
    await withHarness(async (pg, dir) => {
      await expect(
        applyCorePGliteMigrations(dir, clientThatFailsBookkeeping(pg)),
      ).rejects.toBeInstanceOf(BookkeepingFailure);

      // Both halves must be gone. Either one surviving alone is the split-brain
      // state the next boot cannot see: the table without the tag means a
      // replay of a migration that already ran.
      expect(await tableExists(pg, BODY_TABLE)).toBe(false);
      expect(await appliedTags(pg)).toEqual([]);
    });
  });

  it("applies the body and records the tag when nothing fails", async () => {
    // Positive control: without it the assertions above would also hold for a
    // runner that silently applied nothing at all.
    await withHarness(async (pg, dir) => {
      await applyCorePGliteMigrations(dir, pg);

      expect(await tableExists(pg, BODY_TABLE)).toBe(true);
      expect(await appliedTags(pg)).toEqual(["0000_probe"]);
    });
  });

  it("does not re-run a migration whose tag is already recorded", async () => {
    // The tag is the only thing the runner keys on, which is why a lost
    // tracking row is a full replay rather than a skipped statement.
    await withHarness(async (pg, dir) => {
      await applyCorePGliteMigrations(dir, pg);
      // A second pass would raise `relation "…" already exists` if it re-ran.
      await applyCorePGliteMigrations(dir, pg);

      expect(await appliedTags(pg)).toEqual(["0000_probe"]);
    });
  });
});
