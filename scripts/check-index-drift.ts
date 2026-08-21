#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Index drift detector — declared indexes vs. what the database actually has.
 *
 *   DATABASE_URL=postgres://… bun scripts/check-index-drift.ts
 *
 * Why this exists (issue #1182): `packages/db/drizzle/0000_init.sql` is a
 * SQUASH, and production predates it. Anything the squash introduced rather
 * than a forward migration therefore never ran against production — two of the
 * 132 declared indexes turned out to be missing there. The same hole reopens at
 * every future squash, so the manual `psql`/`comm` recipe from the issue is
 * checked in here.
 *
 * The consequence to remember: before any `DROP INDEX`, the SURVIVING index
 * must be verified against the LIVE database. Neither the TS schema nor
 * `0000_init.sql` is evidence that an index exists in production.
 *
 * Declared set: the `tables[*].indexes` keys of the LATEST Drizzle snapshot,
 * resolved from `meta/_journal.json` (never a hardcoded snapshot number).
 * Actual set: `pg_indexes` in the `public` schema.
 *
 * Exit 1 iff an index is declared but absent. See `diffIndexes` for why the
 * opposite direction is informational only.
 */

const META_DIR = `${import.meta.dir}/../packages/db/drizzle/meta`;

/** Actual index names in the database. Exported so the migration-replay test runs the same query. */
export const PUBLIC_INDEXES_QUERY = "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'";

/** The subset of `meta/_journal.json` this script reads. */
export interface DrizzleJournal {
  entries: { idx: number; tag: string }[];
}

/** The subset of `meta/NNNN_snapshot.json` this script reads. */
export interface DrizzleSnapshot {
  tables: Record<string, { indexes?: Record<string, unknown> }>;
}

export interface IndexDiff {
  /** Declared in the snapshot, absent from the database — the failure signal. */
  missing: string[];
  /** Present in the database, absent from the snapshot — informational. */
  undeclared: string[];
}

/**
 * Snapshot filename of the highest `idx` in the journal — `0040_snapshot.json`.
 *
 * Journal entries are appended by `drizzle-kit generate` and are normally
 * contiguous and sorted, but neither is relied upon: only the maximum `idx`
 * matters, and it is zero-padded to the 4 digits drizzle-kit uses.
 */
export function latestSnapshotName(journal: DrizzleJournal): string {
  let latest: number | null = null;
  for (const entry of journal.entries) {
    if (latest === null || entry.idx > latest) latest = entry.idx;
  }
  if (latest === null)
    throw new Error("Drizzle journal has no entries — cannot resolve a snapshot");
  return `${String(latest).padStart(4, "0")}_snapshot.json`;
}

/**
 * Index names DECLARED by a snapshot: the keys of `tables[*].indexes`.
 *
 * Deliberately mirrors the issue's `t.get('indexes', {})` — a table with no
 * explicit index declares none, and constraint-backed indexes (primary keys,
 * unique constraints) are NOT pulled in from `compositePrimaryKeys` /
 * `uniqueConstraints`. See `diffIndexes` for the consequence.
 */
export function declaredIndexes(snapshot: DrizzleSnapshot): Set<string> {
  const names = new Set<string>();
  for (const table of Object.values(snapshot.tables)) {
    for (const name of Object.keys(table.indexes ?? {})) names.add(name);
  }
  return names;
}

/**
 * Two-way diff between declared and actual index names.
 *
 * `missing` is the failure signal: the schema says the index exists, the
 * database disagrees, and every query planned around it is running without it.
 *
 * `undeclared` is INFORMATIONAL and must never fail the run. Postgres creates a
 * backing index for every primary key and unique constraint, so those names
 * legitimately appear in `pg_indexes` while living under `compositePrimaryKeys`
 * / `uniqueConstraints` in the snapshot rather than under `indexes`. Turning
 * this side into a failure would report the entire constraint surface of the
 * database as drift.
 */
export function diffIndexes(declared: Set<string>, actual: Set<string>): IndexDiff {
  return {
    missing: [...declared].filter((name) => !actual.has(name)).sort(),
    undeclared: [...actual].filter((name) => !declared.has(name)).sort(),
  };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const journal: DrizzleJournal = await Bun.file(`${META_DIR}/_journal.json`).json();
  const snapshotName = latestSnapshotName(journal);
  const snapshot: DrizzleSnapshot = await Bun.file(`${META_DIR}/${snapshotName}`).json();
  const declared = declaredIndexes(snapshot);

  // Imported here, not at module scope: `@appstrate/db/client` opens its pool
  // (or spins up PGlite) in a top-level await, so a static import would make the
  // pure helpers above untestable without a database.
  const { reservePgConnection, closeDb } = await import("@appstrate/db/client");

  // Embedded PGlite is created by replaying every migration, so it cannot drift
  // — and it is never the database this check is about. Refuse rather than
  // report a vacuous pass.
  const conn = await reservePgConnection();
  if (!conn) {
    out("No external PostgreSQL: set DATABASE_URL to the database you want to check.");
    return 1;
  }

  let actual: Set<string>;
  try {
    // `.unsafe` rather than a tagged template so the query string stays a
    // shared exported constant. It is a literal with no interpolation, so there
    // is no injection surface — do not "harden" it back into a tagged template,
    // that would fork the query away from the migration-replay test.
    const rows = await conn.sql.unsafe<{ indexname: string }[]>(PUBLIC_INDEXES_QUERY);
    actual = new Set(rows.map((row) => row.indexname));
  } finally {
    conn.release();
    await closeDb();
  }

  const { missing, undeclared } = diffIndexes(declared, actual);

  if (undeclared.length > 0) {
    out(`Undeclared in ${snapshotName} (informational — PK/unique-backed): ${undeclared.length}`);
    for (const name of undeclared) out(`  undeclared  ${name}`);
    out("");
  }

  if (missing.length > 0) {
    out(`Declared in ${snapshotName} but ABSENT from the database: ${missing.length}`);
    for (const name of missing) out(`  missing  ${name}`);
    out("");
    out("Add a forward migration creating them — the squash will not reach this database.");
    return 1;
  }

  out(
    `No index drift: all ${declared.size} indexes declared by ${snapshotName} exist among the ` +
      `${actual.size} indexes in the database.`,
  );
  return 0;
}

// Guarded so tests can import the pure helpers without touching the database.
if (import.meta.main) {
  process.exit(await main());
}
