#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Index drift detector — declared indexes vs. what the database actually has.
 *
 *   cd <repo root> && DATABASE_URL=postgres://… bun scripts/check-index-drift.ts
 *
 * Why this exists (issue #1182): `packages/db/drizzle/0000_init.sql` is a
 * SQUASH, and production predates it. Anything the squash introduced rather
 * than a forward migration therefore never ran against production — two of the
 * declared indexes turned out to be missing there. The same hole reopens at
 * every future squash, so the manual `psql`/`comm` recipe from the issue is
 * checked in here.
 *
 * The consequence to remember: before any `DROP INDEX`, the SURVIVING index
 * must be verified against the LIVE database. Neither the TS schema nor
 * `0000_init.sql` is evidence that an index exists in production.
 *
 * Declared set: the `tables[*].indexes` keys of the snapshot matching the
 * DATABASE'S OWN migration watermark — NOT the newest snapshot on disk. A
 * database that has not yet run the release being deployed legitimately lacks
 * every index that release adds; diffing it against the newest snapshot would
 * report all of them as drift and invite a duplicate migration. Resolution is
 * `max(created_at)` in `drizzle.__drizzle_migrations` → the journal entry whose
 * `when` equals it → that entry's snapshot (see `snapshotNameForWatermark`).
 *
 * Actual set: `pg_indexes` in the `public` schema, split by whether a
 * constraint owns the index (see `CONSTRAINT_BACKED_INDEXES_QUERY`).
 *
 * Exit 1 iff an index is declared but absent, or the check could not run at
 * all. Undeclared indexes never fail the run — see `classifyUndeclared`.
 */

const META_DIR = `${import.meta.dir}/../packages/db/drizzle/meta`;

/** Actual index names in the database. Exported so the migration-replay test runs the same query. */
export const PUBLIC_INDEXES_QUERY = "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'";

/**
 * How far the database has been migrated.
 *
 * `apps/api/src/lib/boot.ts` calls `migrate(db, { migrationsFolder })` with no
 * `migrationsSchema` / `migrationsTable`, so the tracking table is the drizzle
 * default `drizzle.__drizzle_migrations`, and drizzle stores each applied
 * migration's `folderMillis` — the journal entry's `when`, verbatim — in
 * `created_at`. The maximum is therefore directly comparable to a journal
 * `when`, with no clock or timezone conversion in between.
 */
const MIGRATION_WATERMARK_QUERY =
  "SELECT max(created_at)::text AS watermark FROM drizzle.__drizzle_migrations";

/**
 * Index names that exist because a CONSTRAINT declares them.
 *
 * Joined through `pg_constraint.conindid` — the catalog's own link from a
 * constraint to its backing index — rather than testing
 * `pg_index.indisprimary OR indisunique`. The flags would over-claim: a
 * standalone `CREATE UNIQUE INDEX` from a hand-written migration is
 * `indisunique` while no constraint owns it, so an orphaned one would be
 * labelled "expected" and dismissed, which is exactly the reverse-drift case
 * this classification must NOT hide. `contype in ('p','u','x')` is every
 * constraint form Postgres materialises an index for.
 */
const CONSTRAINT_BACKED_INDEXES_QUERY = `
  SELECT c.relname AS indexname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conindid
    JOIN pg_namespace n ON n.oid = con.connamespace
   WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'x')
`;

/** The subset of `meta/_journal.json` this script reads. */
export interface DrizzleJournal {
  entries: { idx: number; tag: string; when: number }[];
}

/** The subset of `meta/NNNN_snapshot.json` this script reads. */
export interface DrizzleSnapshot {
  tables: Record<string, { indexes?: Record<string, unknown> }>;
}

interface IndexDiff {
  /** Declared in the snapshot, absent from the database — the failure signal. */
  missing: string[];
  /** Present in the database, absent from the snapshot — never a failure. */
  undeclared: string[];
}

/** Zero-padded to the 4 digits drizzle-kit uses: `40` → `0040_snapshot.json`. */
function snapshotNameForIdx(idx: number): string {
  return `${String(idx).padStart(4, "0")}_snapshot.json`;
}

/**
 * Snapshot filename of the highest `idx` in the journal — the newest schema on
 * disk. Used only to tell the operator how far ahead the repo is; the diff
 * itself runs against `snapshotNameForWatermark`.
 *
 * Journal entries are appended by `drizzle-kit generate` and are normally
 * contiguous and sorted, but neither is relied upon: only the maximum `idx`
 * matters.
 */
export function latestSnapshotName(journal: DrizzleJournal): string {
  let latest: number | null = null;
  for (const entry of journal.entries) {
    if (latest === null || entry.idx > latest) latest = entry.idx;
  }
  if (latest === null)
    throw new Error("Drizzle journal has no entries — cannot resolve a snapshot");
  return snapshotNameForIdx(latest);
}

/**
 * Snapshot matching a database's migration watermark, plus how many journal
 * entries sit beyond it.
 *
 * The match is EXACT: drizzle writes the journal `when` into `created_at`
 * unchanged, so an equal value is the only correct pairing. Returns `null` when
 * no entry matches rather than falling back to the nearest one — this repo
 * squashes its journal, so a watermark can outlive the entry that produced it,
 * and quietly diffing against a neighbouring snapshot would compare the
 * database to a schema it never had. That is the same class of silent
 * mismatch the whole script exists to catch.
 */
export function snapshotNameForWatermark(
  journal: DrizzleJournal,
  watermark: number,
): { snapshotName: string; tag: string; pending: number } | null {
  const match = journal.entries.find((entry) => entry.when === watermark);
  if (!match) return null;
  return {
    snapshotName: snapshotNameForIdx(match.idx),
    tag: match.tag,
    pending: journal.entries.filter((entry) => entry.when > watermark).length,
  };
}

/**
 * Index names DECLARED by a snapshot: the keys of `tables[*].indexes`.
 *
 * Deliberately mirrors the issue's `t.get('indexes', {})` — a table with no
 * explicit index declares none, and constraint-backed indexes (primary keys,
 * unique constraints) are NOT pulled in from `compositePrimaryKeys` /
 * `uniqueConstraints`. See `classifyUndeclared` for the consequence.
 */
export function declaredIndexes(snapshot: DrizzleSnapshot): Set<string> {
  const names = new Set<string>();
  for (const table of Object.values(snapshot.tables)) {
    for (const name of Object.keys(table.indexes ?? {})) names.add(name);
  }
  return names;
}

/**
 * Two-way set difference between declared and actual index names.
 *
 * `missing` is the failure signal: the schema says the index exists, the
 * database disagrees, and every query planned around it is running without it.
 *
 * `undeclared` is raw — it mixes two very different populations, which
 * `classifyUndeclared` separates from the catalog.
 */
export function diffIndexes(declared: Set<string>, actual: Set<string>): IndexDiff {
  return {
    missing: [...declared].filter((name) => !actual.has(name)).sort(),
    undeclared: [...actual].filter((name) => !declared.has(name)).sort(),
  };
}

/**
 * Split undeclared indexes by whether the catalog says a constraint owns them.
 *
 * `expected`: a primary key or unique constraint materialised it, so it
 * legitimately lives under `compositePrimaryKeys` / `uniqueConstraints` in the
 * snapshot rather than under `indexes`. Nothing to act on — reported as a count.
 *
 * `reverseDrift`: nothing in the snapshot and no constraint behind it. This is
 * the mirror of the bug this script exists for — an index that pre-squash
 * production still carries because the squash dropped it from the schema
 * without a forward `DROP INDEX`. Listed by name, because dismissing it is a
 * decision an operator has to make deliberately.
 *
 * Neither bucket fails the run: `missing` is the only exit-1 signal.
 */
export function classifyUndeclared(
  undeclared: string[],
  constraintBacked: Set<string>,
): { expected: string[]; reverseDrift: string[] } {
  return {
    expected: undeclared.filter((name) => constraintBacked.has(name)),
    reverseDrift: undeclared.filter((name) => !constraintBacked.has(name)),
  };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Postgres `undefined_table` — the tracking table has never been created. */
function isUndefinedTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

async function main(): Promise<number> {
  const journal: DrizzleJournal = await Bun.file(`${META_DIR}/_journal.json`).json();

  // Imported here, not at module scope: `@appstrate/db/client` opens its pool
  // (or spins up PGlite) in a top-level await, so a static import would make the
  // pure helpers above untestable without a database.
  const { reservePgConnection, closeDb } = await import("@appstrate/db/client");

  // Embedded PGlite is created by replaying every migration, so it cannot drift
  // — and it is never the database this check is about. Refuse rather than
  // report a vacuous pass.
  const conn = await reservePgConnection();
  if (!conn) {
    out("Cannot check: no external PostgreSQL. Set DATABASE_URL to the database to check.");
    return 1;
  }

  let watermark: number | null = null;
  let neverMigrated = false;
  const actual = new Set<string>();
  const constraintBacked = new Set<string>();
  try {
    // `.unsafe` rather than a tagged template so each query string stays a
    // shared exported constant. They are literals with no interpolation, so
    // there is no injection surface — do not "harden" them back into tagged
    // templates, that would fork PUBLIC_INDEXES_QUERY away from the
    // migration-replay test that imports and executes it.
    try {
      const rows = await conn.sql.unsafe<{ watermark: string | null }[]>(MIGRATION_WATERMARK_QUERY);
      const raw = rows[0]?.watermark ?? null;
      watermark = raw === null ? null : Number(raw);
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
      neverMigrated = true;
    }

    if (watermark !== null) {
      for (const row of await conn.sql.unsafe<{ indexname: string }[]>(PUBLIC_INDEXES_QUERY)) {
        actual.add(row.indexname);
      }
      for (const row of await conn.sql.unsafe<{ indexname: string }[]>(
        CONSTRAINT_BACKED_INDEXES_QUERY,
      )) {
        constraintBacked.add(row.indexname);
      }
    }
  } finally {
    conn.release();
    await closeDb();
  }

  // All three refusals below exit 1 and say "Cannot check": the check did not
  // run, and an operator must never be able to read that as "no drift".
  if (neverMigrated) {
    out("Cannot check: drizzle.__drizzle_migrations does not exist — never migrated.");
    return 1;
  }
  if (watermark === null) {
    out("Cannot check: drizzle.__drizzle_migrations is empty — no migration has been applied.");
    return 1;
  }

  const at = snapshotNameForWatermark(journal, watermark);
  if (!at) {
    out(`Cannot check: watermark ${watermark} matches no entry in meta/_journal.json.`);
    out("The journal was squashed or hand-edited since this database migrated. Diffing against");
    out("a neighbouring snapshot would compare it to a schema it never had — resolve by hand.");
    return 1;
  }

  out(
    at.pending === 0
      ? `Database is at ${at.tag} (up to date). Diffing against ${at.snapshotName}.`
      : `Database is at ${at.tag}; ${at.pending} migration(s) pending (latest on disk: ` +
          `${latestSnapshotName(journal)}). Diffing against ${at.snapshotName}.`,
  );
  out("");

  const snapshot: DrizzleSnapshot = await Bun.file(`${META_DIR}/${at.snapshotName}`).json();
  const declared = declaredIndexes(snapshot);
  const { missing, undeclared } = diffIndexes(declared, actual);
  const { expected, reverseDrift } = classifyUndeclared(undeclared, constraintBacked);

  if (expected.length > 0) {
    out(`Undeclared but constraint-backed (expected, not drift): ${expected.length}`);
  }

  if (reverseDrift.length > 0) {
    out(`Undeclared and NOT constraint-backed: ${reverseDrift.length}`);
    for (const name of reverseDrift) out(`  possible reverse drift  ${name}`);
    out("An index the schema no longer declares and no constraint owns — a squash may have");
    out("dropped it without a forward DROP INDEX. Verify before removing it.");
  }

  if (expected.length > 0 || reverseDrift.length > 0) out("");

  if (missing.length > 0) {
    out(`Declared in ${at.snapshotName} but ABSENT from the database: ${missing.length}`);
    for (const name of missing) out(`  missing  ${name}`);
    out("");
    out("These are declared by a migration the database has already applied, so the squash");
    out("never reached it. Add a forward migration creating them.");
    return 1;
  }

  out(
    `No index drift: all ${declared.size} indexes declared by ${at.snapshotName} exist among the ` +
      `${actual.size} indexes in the database.`,
  );
  return 0;
}

// Guarded so tests can import the pure helpers without touching the database.
if (import.meta.main) {
  process.exit(await main());
}
