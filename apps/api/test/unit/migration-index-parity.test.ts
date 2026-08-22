// SPDX-License-Identifier: Apache-2.0

/**
 * Migration replay vs. declared schema — index parity (issue #1182).
 *
 * A Drizzle snapshot is not evidence that any SQL creates what it declares.
 * The two are written by the same `db:generate` invocation and then drift
 * apart silently, because `0000_init.sql` is a SQUASH: a database created
 * BEFORE the squash treats it as history and never runs it, while the snapshot
 * goes on declaring everything the squash introduced. Nothing looks wrong
 * while that is true — the journal is contiguous, `__drizzle_migrations` has
 * no gap, the TS schema and the checked-in SQL agree — and production still
 * turned out to be missing two of the indexes it declared.
 *
 * `scripts/check-index-drift.ts` catches that class against a LIVE database,
 * which means an operator has to point it at production. This file covers the
 * two halves that can be reached without one, and they are different tests:
 *
 *   - a replay of the journal into a throwaway PGlite must contain every index
 *     the latest snapshot declares, so a snapshot that declares an index NO
 *     SQL anywhere creates fails at the commit that introduces it;
 *   - and the fix itself, `0041_restore_squash_indexes.sql`, must actually
 *     restore both indexes on a database that LACKS them. A replay alone
 *     cannot show that: the replay starts at the squash, which already creates
 *     both, so every assertion about their mere presence would pass with 0041
 *     deleted from the branch. The production population is therefore modelled
 *     explicitly, by dropping them first.
 *
 * The diff helpers and the `pg_indexes` query are IMPORTED from that script
 * rather than reimplemented: a second copy would be free to disagree with the
 * operator check, and "the two detectors disagreed" is the failure mode being
 * pinned here.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyCorePGliteMigrations } from "../../src/lib/pglite-migrate.ts";
import {
  PUBLIC_INDEXES_QUERY,
  latestSnapshotName,
  declaredIndexes,
  diffIndexes,
  type DrizzleJournal,
  type DrizzleSnapshot,
} from "../../../../scripts/check-index-drift.ts";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../../packages/db/drizzle");
const META_DIR = `${MIGRATIONS_DIR}/meta`;

/** The forward migration from #1182. Always re-read from disk — never inlined. */
const RESTORE_SQL_PATH = `${MIGRATIONS_DIR}/0041_restore_squash_indexes.sql`;

/** The two indexes #1182 found missing on production. */
const RESTORED = ["idx_runs_package_started", "idx_runs_schedule_id"] as const;

/**
 * Own throwaway database, not the suite's shared PGlite: this file must build
 * its subject from the migrations alone, so it cannot borrow a database whose
 * shape someone else already decided.
 */
const pg = new PGlite();

let journal: DrizzleJournal;
let declared: Set<string>;
let actual: Set<string>;

/** Actual index names, read the way the operator check reads them. */
async function readIndexNames(): Promise<Set<string>> {
  const { rows } = await pg.query<{ indexname: string }>(PUBLIC_INDEXES_QUERY);
  return new Set(rows.map((row) => row.indexname));
}

async function indexDefinition(name: string): Promise<string | undefined> {
  const { rows } = await pg.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
    [name],
  );
  return rows[0]?.indexdef;
}

/** Run a migration file the way the runner does — whole file, breakpoints stripped. */
async function execMigrationFile(path: string): Promise<void> {
  const sql = await Bun.file(path).text();
  await pg.exec(sql.replaceAll("--> statement-breakpoint", ""));
}

// No timing assertion here on purpose: `bunfig.toml` sets `timeout = 15000`
// and bun applies it to hooks, so a replay that ever grows that slow kills
// this file outright. A softer ceiling of our own could never fire.
beforeAll(async () => {
  journal = await Bun.file(`${META_DIR}/_journal.json`).json();
  const snapshotName = latestSnapshotName(journal);
  const snapshot: DrizzleSnapshot = await Bun.file(`${META_DIR}/${snapshotName}`).json();
  declared = declaredIndexes(snapshot);

  await applyCorePGliteMigrations(MIGRATIONS_DIR, pg);
  actual = await readIndexNames();
});

afterAll(async () => {
  await pg.close();
});

describe("migration replay index parity", () => {
  it("creates every index the latest snapshot declares", () => {
    // This is a guard on the SNAPSHOT, not on 0041. It fails when the latest
    // snapshot declares an index that no SQL in the journal creates — the
    // desync that let #1182 sit unnoticed. It says nothing about whether 0041
    // works: both of its indexes are already created by the squash, so this
    // assertion passes with 0041 deleted. The test below is the one that
    // covers the fix.
    //
    // `undeclared` is deliberately not asserted: Postgres backs every primary
    // key and unique constraint with an index that lives outside
    // `tables[*].indexes`, so that side is noise, not drift.
    const { missing } = diffIndexes(declared, actual);
    expect(missing).toEqual([]);
    expect(declared.size).toBeGreaterThan(0);
  });

  it("restores both indexes on a database that lacks them (issue #1182)", async () => {
    // Models the ONE population 0041 exists for: production, which predates
    // the squash and therefore never got these two. A replayed database has
    // them, so drop them first — that is what production looked like.
    //
    // This test leaves the database exactly as it found it (both indexes
    // present, since restoring them is the assertion), so it is order-
    // independent with respect to the re-apply test below.
    for (const name of RESTORED) {
      await pg.query(`DROP INDEX "${name}"`);
    }
    const lacking = await readIndexNames();
    expect(RESTORED.filter((name) => lacking.has(name))).toEqual([]);

    await execMigrationFile(RESTORE_SQL_PATH);

    const restored = await readIndexNames();
    expect(RESTORED.filter((name) => !restored.has(name))).toEqual([]);

    // A partial index restored as a full one is a DIFFERENT index: it covers
    // rows the schema says it does not, and every plan costed against the
    // narrow one is costed wrong. Assert the predicate came back with it.
    const definition = await indexDefinition("idx_runs_schedule_id");
    expect(definition).toContain("WHERE");
    expect(definition).toMatch(/schedule_id IS NOT NULL/);
  });

  it("re-applies 0041 without error or effect", async () => {
    // The OTHER population, stated explicitly rather than inherited from
    // whichever test ran first: every database created FROM the squash already
    // has both indexes, which is nearly all of them.
    const before = await readIndexNames();
    expect(RESTORED.filter((name) => !before.has(name))).toEqual([]);

    // Drizzle wraps the whole pending batch in ONE transaction, so an
    // `already exists` raised here would abort every other pending migration
    // and wedge the deploy. `IF NOT EXISTS` is what keeps 0041 a no-op for
    // this population.
    await execMigrationFile(RESTORE_SQL_PATH);

    const after = await readIndexNames();
    expect(after.size).toBe(before.size);
    expect(RESTORED.filter((name) => !after.has(name))).toEqual([]);
  });

  it("has a .sql file for every journal entry", async () => {
    // Cheap, and it catches the one thing the replay cannot report: a
    // hand-authored journal entry pointing at nothing. The migration runner
    // logs a warning and SKIPS a missing file, so a typo'd tag would leave the
    // parity assertion above passing against an incomplete database.
    //
    // The SNAPSHOT file is deliberately not asserted here: `beforeAll` already
    // reads it with `.json()`, which throws if it is absent, so the suite dies
    // in the hook and an assertion on this line could only ever run in a world
    // where it is already true.
    const missingFiles: string[] = [];
    for (const entry of journal.entries) {
      if (!(await Bun.file(`${MIGRATIONS_DIR}/${entry.tag}.sql`).exists())) {
        missingFiles.push(entry.tag);
      }
    }
    expect(missingFiles).toEqual([]);
  });
});
