#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Index drift detector — declared indexes vs. what the database actually has.
 *
 *   DATABASE_URL=postgres://… bun scripts/check-index-drift.ts
 *
 * `DATABASE_URL` is the ONLY input. It is read straight off `process.env` and
 * opened with Bun's native SQL client, so the script never loads `@appstrate/env`
 * and never needs a populated `.env` — an operator on a jump host with nothing
 * but a production connection string can run it. Paths are derived from
 * `import.meta.dir`, so the working directory does not matter either.
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
 * `when` equals it → that entry's snapshot.
 *
 * Actual set: every index in `public` EXCEPT those on a table a workspace module owns, read from
 * that module's own drizzle snapshot (`scripts/lib/drizzle-snapshots.ts`), never from a prefix.
 *
 * SCOPE — this compares index NAMES ONLY. An index that exists under the
 * expected name with a different definition (other columns, a lost partial
 * predicate, lost uniqueness) reads as present. That is a real variant of this
 * drift class — a squash can redefine an index while a pre-squash database
 * keeps the old shape under the same name — and it is deliberately out of
 * scope: rendering snapshot entries into comparable DDL is fiddly and
 * false-positive-prone. Every message the script prints says so.
 *
 * Exit 1 iff an index is declared but absent, or the check could not run at
 * all. Undeclared indexes never fail the run.
 */

import {
  declaredTables,
  latestSnapshotName,
  moduleOwnedTables,
  snapshotNameForIdx,
  type DrizzleJournal,
  type DrizzleSnapshot,
} from "./lib/drizzle-snapshots.ts";

const REPO_ROOT = `${import.meta.dir}/..`;
const META_DIR = `${REPO_ROOT}/packages/db/drizzle/meta`;

/**
 * Actual indexes in the database, each with the table it sits on. Exported so
 * the migration-replay test runs the same query. The table is what subtracts module-owned tables
 * and what every reported index is named with — an index name alone is not enough to act on.
 */
export const PUBLIC_INDEXES_QUERY =
  "SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'public'";

/**
 * Does the drizzle tracking table exist at all?
 *
 * Asked with `to_regclass` — which returns NULL for an unknown relation instead
 * of raising — rather than by running the watermark query and classifying the
 * failure. Bun's `PostgresError.code` is a Bun-level symbol
 * (`ERR_POSTGRES_SERVER_ERROR`) and the SQLSTATE lives in `errno`, so an
 * error-code test here would encode a driver detail that a Bun upgrade can
 * move. This asks the catalog the question directly.
 */
const TRACKING_TABLE_QUERY = "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS present";

/**
 * How far the database has been migrated.
 *
 * `apps/api/src/lib/boot.ts` calls `migrate(db, { migrationsFolder })` with no
 * `migrationsSchema` / `migrationsTable`, so the tracking table is the drizzle
 * default `drizzle.__drizzle_migrations`, and drizzle stores each applied
 * migration's `folderMillis` — the journal entry's `when`, verbatim — in
 * `created_at`. The maximum is therefore directly comparable to a journal
 * `when`, with no clock or timezone conversion in between. Cast to text
 * because `created_at` is a bigint.
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

/** One row of `PUBLIC_INDEXES_QUERY`. */
interface ActualIndex {
  indexname: string;
  tablename: string;
}

interface IndexDiff {
  /** Declared in the snapshot, absent from the database — the failure signal. */
  missing: string[];
  /** Present in the database, absent from the snapshot — never a failure. */
  undeclared: string[];
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
function snapshotNameForWatermark(
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
 * Index names DECLARED by a snapshot, restricted to the PUBLIC schema.
 *
 * The schema filter mirrors `PUBLIC_INDEXES_QUERY`'s `schemaname = 'public'`:
 * without it, the first `pgSchema(...)` table carrying an index would turn
 * every one of its indexes into a hard `missing` against a perfectly healthy
 * database, because the actual side would never have looked outside `public`.
 * Drizzle writes `""` for the public schema and the schema name otherwise.
 *
 * Otherwise deliberately mirrors the issue's `t.get('indexes', {})` — a table
 * with no explicit index declares none, and constraint-backed indexes are NOT
 * pulled in from `compositePrimaryKeys` / `uniqueConstraints`.
 */
export function declaredIndexes(snapshot: DrizzleSnapshot): Set<string> {
  const names = new Set<string>();
  for (const table of Object.values(snapshot.tables)) {
    const schema = table.schema ?? "";
    if (schema !== "" && schema !== "public") continue;
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
function classifyUndeclared(
  undeclared: string[],
  constraintBacked: Set<string>,
): { expected: string[]; reverseDrift: string[] } {
  return {
    expected: undeclared.filter((name) => constraintBacked.has(name)),
    reverseDrift: undeclared.filter((name) => !constraintBacked.has(name)),
  };
}

/**
 * Every decision and every printed line, given what the database said.
 *
 * Exported and pure so the exit codes and the report are reachable from a test
 * without a database — `main()` below keeps nothing but I/O. A regression that
 * flips the missing-index path to exit 0 has to break a test here.
 *
 * `loadSnapshot` is injected rather than read from disk because WHICH snapshot
 * to load is one of the decisions this function makes.
 */
export async function runCheck(input: {
  journal: DrizzleJournal;
  /** False when `drizzle.__drizzle_migrations` does not exist. */
  trackingTableExists: boolean;
  /** Null when the tracking table exists but holds no applied migration. */
  watermark: number | null;
  actual: ActualIndex[];
  constraintBacked: Set<string>;
  /** Table name → the module package that owns it; its indexes are in no platform snapshot, so
   * subtracting by NAME leaves a platform table the schema stopped declaring in the comparison. */
  moduleTables: ReadonlyMap<string, string>;
  loadSnapshot: (snapshotName: string) => Promise<DrizzleSnapshot>;
}): Promise<{ exitCode: number; lines: string[] }> {
  const lines: string[] = [];

  // Every refusal below exits 1 and opens with "Cannot check": the check did
  // not run, and an operator must never be able to read that as "no drift".
  if (!input.trackingTableExists) {
    lines.push("Cannot check: drizzle.__drizzle_migrations does not exist — never migrated.");
    return { exitCode: 1, lines };
  }
  if (input.watermark === null) {
    lines.push(
      "Cannot check: drizzle.__drizzle_migrations is empty — no migration has been applied.",
    );
    return { exitCode: 1, lines };
  }

  const at = snapshotNameForWatermark(input.journal, input.watermark);
  if (!at) {
    lines.push(
      `Cannot check: watermark ${input.watermark} matches no entry in meta/_journal.json.`,
    );
    lines.push(
      "The journal was squashed or hand-edited since this database migrated. Diffing against",
    );
    lines.push(
      "a neighbouring snapshot would compare it to a schema it never had — resolve by hand.",
    );
    return { exitCode: 1, lines };
  }

  lines.push(
    at.pending === 0
      ? `Database is at ${at.tag} (up to date). Diffing against ${at.snapshotName}.`
      : `Database is at ${at.tag}; ${at.pending} migration(s) pending (latest on disk: ` +
          `${latestSnapshotName(input.journal)}). Diffing against ${at.snapshotName}.`,
  );
  lines.push("");

  const snapshot = await input.loadSnapshot(at.snapshotName);
  const declared = declaredIndexes(snapshot);
  const tables = declaredTables(snapshot);

  // Exactly the module-owned tables are subtracted, and no more (see `moduleTables`).
  const skipped: ActualIndex[] = [];
  const considered: ActualIndex[] = [];
  for (const row of input.actual) {
    // A table BOTH sides declare is compared as the platform's — the watermark resolved against it.
    if (!tables.has(row.tablename) && input.moduleTables.has(row.tablename)) skipped.push(row);
    else considered.push(row);
  }
  const tableOf = new Map(considered.map((row) => [row.indexname, row.tablename]));
  const actual = new Set(considered.map((row) => row.indexname));
  const { missing, undeclared } = diffIndexes(declared, actual);
  const { expected, reverseDrift } = classifyUndeclared(undeclared, input.constraintBacked);
  const undeclaredTables = [
    ...new Set(considered.filter((row) => !tables.has(row.tablename)).map((r) => r.tablename)),
  ].sort();

  if (skipped.length > 0) {
    const owners = [
      ...new Set(skipped.map((row) => input.moduleTables.get(row.tablename)!)),
    ].sort();
    const onTables = new Set(skipped.map((row) => row.tablename));
    lines.push(
      `Skipped ${skipped.length} index(es) on ${onTables.size} table(s) owned by ` +
        `${owners.join(", ")} — each migrates under a journal of its own.`,
    );
  }
  if (undeclaredTables.length > 0) {
    lines.push(`Tables in the database that ${at.snapshotName} does not declare, and no module`);
    lines.push(`owns: ${undeclaredTables.length}`);
    for (const name of undeclaredTables) lines.push(`  undeclared table  ${name}`);
  }
  if (expected.length > 0) {
    lines.push(`Undeclared but constraint-backed (expected, not drift): ${expected.length}`);
  }
  if (reverseDrift.length > 0) {
    lines.push(`Undeclared and NOT constraint-backed: ${reverseDrift.length}`);
    for (const name of reverseDrift) {
      lines.push(`  possible reverse drift  ${name}  on ${tableOf.get(name)}`);
    }
    lines.push("An index the schema no longer declares and no constraint owns — a squash may have");
    lines.push("dropped it without a forward DROP INDEX. Verify before removing it.");
  }
  if (
    skipped.length > 0 ||
    undeclaredTables.length > 0 ||
    expected.length > 0 ||
    reverseDrift.length > 0
  )
    lines.push("");

  if (missing.length > 0) {
    lines.push(`Declared in ${at.snapshotName} but ABSENT from the database: ${missing.length}`);
    for (const name of missing) lines.push(`  missing  ${name}`);
    lines.push("");
    lines.push("These are declared by a migration the database has already applied, so the squash");
    lines.push("never reached it. Add a forward migration creating them.");
    return { exitCode: 1, lines };
  }

  lines.push(
    `No missing index: all ${declared.size} indexes declared by ${at.snapshotName} are present ` +
      `among the ${actual.size} the database carries outside the module-owned tables.`,
  );
  lines.push(
    "Names only — index DEFINITIONS (columns, uniqueness, partial predicates) are not compared.",
  );
  return { exitCode: 0, lines };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const journal: DrizzleJournal = await Bun.file(`${META_DIR}/_journal.json`).json();

  // An embedded PGlite database is built by replaying every migration, so it
  // cannot drift — and it is never the database this check is about. Refuse
  // rather than report a vacuous pass.
  const url = process.env.DATABASE_URL;
  if (!url) {
    out("Cannot check: DATABASE_URL is not set — point it at the database to check.");
    out("(An embedded PGlite database replays every migration, so it cannot drift.)");
    return 1;
  }

  const sql = new Bun.SQL(url);
  let trackingTableExists: boolean;
  let watermark: number | null = null;
  const actual: ActualIndex[] = [];
  const constraintBacked = new Set<string>();
  try {
    // `.unsafe` rather than tagged templates so each query stays a named
    // constant. They are literals with no interpolation, so there is no
    // injection surface — do not "harden" them into tagged templates, that
    // would fork PUBLIC_INDEXES_QUERY away from the migration-replay test that
    // imports and executes it.
    const [tracking] = await sql.unsafe<{ present: string | null }[]>(TRACKING_TABLE_QUERY);
    trackingTableExists = (tracking?.present ?? null) !== null;

    if (trackingTableExists) {
      const [row] = await sql.unsafe<{ watermark: string | null }[]>(MIGRATION_WATERMARK_QUERY);
      const raw = row?.watermark ?? null;
      watermark = raw === null ? null : Number(raw);
    }

    for (const row of await sql.unsafe<ActualIndex[]>(PUBLIC_INDEXES_QUERY)) {
      actual.push(row);
    }
    for (const row of await sql.unsafe<{ indexname: string }[]>(CONSTRAINT_BACKED_INDEXES_QUERY)) {
      constraintBacked.add(row.indexname);
    }
  } finally {
    await sql.close();
  }

  // Discovered from the module trees on disk: `ee_%` would both over- and under-match.
  const moduleTables = new Map<string, string>();
  for (const module of await moduleOwnedTables(REPO_ROOT)) {
    for (const table of module.tables) moduleTables.set(table, module.packageDir);
  }

  const { exitCode, lines } = await runCheck({
    journal,
    trackingTableExists,
    watermark,
    actual,
    constraintBacked,
    moduleTables,
    loadSnapshot: (snapshotName) => Bun.file(`${META_DIR}/${snapshotName}`).json(),
  });
  for (const line of lines) out(line);
  return exitCode;
}

// Guarded so tests can import the pure functions without touching the database.
if (import.meta.main) {
  process.exit(await main());
}
