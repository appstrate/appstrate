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
 * turned out to be missing two of its 132 declared indexes.
 *
 * `scripts/check-index-drift.ts` catches that class against a LIVE database,
 * which means an operator has to point it at production. This test catches the
 * other half of it in CI, with no database to point at: it replays the journal
 * into a throwaway PGlite and diffs the result against the latest snapshot. An
 * index that exists only because a snapshot says so, with no SQL anywhere that
 * creates it, now fails at the commit that introduces it rather than months
 * later on one production catalog.
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

/** The forward migration from #1182 — re-executed below to prove it is a no-op. */
const RESTORE_SQL = `${MIGRATIONS_DIR}/0041_restore_squash_indexes.sql`;

/**
 * Own throwaway database, not the suite's shared PGlite: this file must build
 * its subject from the migrations alone, so it cannot borrow a database whose
 * shape someone else already decided.
 */
const pg = new PGlite();

let journal: DrizzleJournal;
let snapshotName: string;
let declared: Set<string>;
let actual: Set<string>;
/** Wall-clock cost of the replay — the reason this file could outgrow test/unit. */
let replayMs = 0;

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

beforeAll(async () => {
  journal = await Bun.file(`${META_DIR}/_journal.json`).json();
  snapshotName = latestSnapshotName(journal);
  const snapshot: DrizzleSnapshot = await Bun.file(`${META_DIR}/${snapshotName}`).json();
  declared = declaredIndexes(snapshot);

  // Pay the WASM boot before the clock starts — the number worth watching is
  // the journal replay, not PGlite's startup.
  await pg.waitReady;
  const started = performance.now();
  await applyCorePGliteMigrations(MIGRATIONS_DIR, pg);
  replayMs = performance.now() - started;

  actual = await readIndexNames();
});

afterAll(async () => {
  await pg.close();
});

describe("migration replay index parity", () => {
  it("creates every index the latest snapshot declares", () => {
    // The whole point of the file. `undeclared` is deliberately not asserted:
    // Postgres backs every primary key and unique constraint with an index that
    // lives outside `tables[*].indexes`, so that side is noise, not drift.
    const { missing } = diffIndexes(declared, actual);
    expect(missing).toEqual([]);
    expect(declared.size).toBeGreaterThan(0);
  });

  // Issue #1182: these two were the only declared indexes absent from
  // production. Named explicitly so a future squash that quietly drops one
  // fails on the name, not just on a count.
  it("creates idx_runs_package_started (issue #1182)", () => {
    expect(actual.has("idx_runs_package_started")).toBe(true);
  });

  it("creates idx_runs_schedule_id, still PARTIAL (issue #1182)", async () => {
    expect(actual.has("idx_runs_schedule_id")).toBe(true);

    // A partial index silently created as a full one is a DIFFERENT index: it
    // covers rows the schema says it does not, and every plan costed against
    // the narrow one is costed wrong. Assert the predicate survived replay.
    const definition = await indexDefinition("idx_runs_schedule_id");
    expect(definition).toContain("WHERE");
    expect(definition).toMatch(/schedule_id IS NOT NULL/);
  });

  it("re-applies 0041 without error or effect", async () => {
    // Drizzle wraps the whole pending batch in ONE transaction, so an
    // `already exists` raised here would abort every other pending migration
    // and wedge the deploy. `IF NOT EXISTS` is what keeps 0041 a no-op on the
    // population that already has both indexes — every database created FROM
    // the squash, which is nearly all of them. Replay it against the
    // already-migrated database, exactly as the runner would.
    const before = (await readIndexNames()).size;
    const sql = await Bun.file(RESTORE_SQL).text();
    await pg.exec(sql.replaceAll("--> statement-breakpoint", ""));
    const after = await readIndexNames();

    expect(after.size).toBe(before);
    expect(after.has("idx_runs_package_started")).toBe(true);
    expect(after.has("idx_runs_schedule_id")).toBe(true);
  });

  it("has a .sql file for every journal entry and a file for the latest snapshot", async () => {
    // Cheap, and it catches the one thing the replay cannot report: a
    // hand-authored journal entry pointing at nothing. The migration runner
    // logs a warning and SKIPS a missing file, so a typo'd tag would leave the
    // parity assertion above passing against an incomplete database.
    const missingFiles: string[] = [];
    for (const entry of journal.entries) {
      if (!(await Bun.file(`${MIGRATIONS_DIR}/${entry.tag}.sql`).exists())) {
        missingFiles.push(entry.tag);
      }
    }
    expect(missingFiles).toEqual([]);
    expect(await Bun.file(`${META_DIR}/${snapshotName}`).exists()).toBe(true);
  });

  it("replays the journal in seconds, not minutes", () => {
    // Not a performance assertion — a home assertion. This file earns its
    // place in test/unit only while the replay is cheap; if the journal grows
    // past this ceiling the file belongs in test/integration/.
    expect(replayMs).toBeLessThan(60_000);
  });
});
