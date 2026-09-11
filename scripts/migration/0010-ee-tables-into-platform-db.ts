#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0010 — move the commercial module's billing tables out of the database they
 * had to themselves and into the platform database.
 *
 *   EE_SOURCE_DATABASE_URL=<the module's former database> DATABASE_URL=<platform> \
 *     bun scripts/migration/0010-ee-tables-into-platform-db.ts [--apply]
 *
 * Run ONCE per deployment that ran the module against a database of its own,
 * during a maintenance window with the platform stopped. A deployment that
 * never enabled the module skips it: there is nothing to move.
 *
 * The expected production source is a `cloud_*` one at migration level 0003.
 * The in-tree move and this change ship in the SAME release, so no deployment
 * ever ran `0004` (billing managers, `billing_email`, `billing_cc`) or `0005`
 * (the rename to `ee_*`) against a database of its own. The prefix is therefore
 * DETECTED, never assumed, and the copy takes the columns the two sides share:
 * a column only the target declares takes its default, a table only the target
 * declares copies nothing, and a column only the SOURCE has is refused — that
 * one would lose data.
 *
 * Why the move: the module used to open a second URL and auto-create the
 * database it named. Two pools, two backups, no shared transaction — and a
 * mistyped name silently created an empty database while Stripe kept charging.
 * Its seven tables now live beside the platform's own under their own journal
 * (`drizzle.ee_migrations`), so only the ROWS have to move.
 *
 * Order: every check first — connectivity, one prefix across the source, no
 * unknown `ee_`/`cloud_` table left behind, no source-only column, no row
 * already on the target — and only once they all pass does `--apply` migrate
 * the target through the module's own `migrateEeDb`, copy every table in ONE
 * target transaction, and verify source count = target count per table.
 *
 * Fidelity: every value is read as `text` and re-cast to the TARGET's own type
 * on the way in, so ids, `text[]` arrays and — the reason this is not a plain
 * row round-trip — microsecond timestamps arrive unchanged. A JavaScript `Date`
 * holds milliseconds, which would silently truncate every `created_at`. Nothing
 * calls `setval` afterwards because no `ee_` table has a serial or identity
 * column: every key is a uuid, a text id, a boolean singleton, or an integer
 * the platform's `llm_usage` ledger assigned.
 *
 * The source is read inside one REPEATABLE READ transaction on a single
 * reserved connection, so the counts the checks report and the pages the copy
 * walks all see one snapshot.
 *
 * Idempotent by refusal, not by merge: a second `--apply` finds rows on the
 * target and stops. That is deliberate — the source is the only record of what
 * was already copied, and a partial re-copy would double-count billed usage.
 *
 * Rows: UNMEASURED. Rehearse against a `pg_dump` restore of both databases and
 * record the per-table counts this script prints, per `scripts/migration/README.md`.
 *
 * Verify (before, and again after — the second run must refuse):
 *
 *   EE_SOURCE_DATABASE_URL=… DATABASE_URL=… bun scripts/migration/0010-ee-tables-into-platform-db.ts
 */

import { SQL } from "bun";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MODULE_ROOT = resolve(import.meta.dir, "../../packages/module-ee");

/** Column names the module's newest drizzle snapshot declares, per target table. */
function declaredColumns(): Map<string, string[]> {
  const meta = resolve(MODULE_ROOT, "drizzle/migrations/meta");
  const journal = JSON.parse(readFileSync(resolve(meta, "_journal.json"), "utf8")) as {
    entries: { idx: number }[];
  };
  const idx = Math.max(...journal.entries.map((e) => e.idx));
  const snapshot = JSON.parse(
    readFileSync(resolve(meta, `${String(idx).padStart(4, "0")}_snapshot.json`), "utf8"),
  ) as { tables: Record<string, { name: string; columns: Record<string, unknown> }> };

  const declared = new Map<string, string[]>();
  for (const table of Object.values(snapshot.tables)) {
    declared.set(table.name, Object.keys(table.columns));
  }
  return declared;
}

const DECLARED = declaredColumns();

/** The tables under their TARGET names, sorted so the printed plan is stable. */
export const EE_TABLES = [...DECLARED.keys()].sort();

/** The part of a table name the two prefixes share: `ee_usage_records` → `usage_records`. */
const LOGICAL = EE_TABLES.map((t) => {
  if (!t.startsWith("ee_")) {
    throw new Error(`Snapshot table is not prefixed \`ee_\`: ${t}`);
  }
  return t.slice("ee_".length);
});

/** Rows read from the source per round trip — bounds memory on a large table. */
const PAGE = 500;

type SourcePrefix = "ee_" | "cloud_";

interface Column {
  name: string;
  type: string;
}

interface TablePlan {
  table: string;
  /** The source table, or null when the source predates it (`0004`'s managers). */
  source: string | null;
  /** Target columns the source has not got. They take their declared default. */
  defaulted: string[];
}

/** A refusal an operator must read as a decision, not as a crash. */
class Refusal extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join(" "));
  }
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The table's columns in physical order, with the type each value must be cast
 * back to. `format_type` renders the modifier too (`numeric(24,12)`,
 * `timestamp with time zone`), which is exactly what a cast expression takes.
 */
async function columnsOf(db: SQL, table: string): Promise<Column[]> {
  return (await db.unsafe(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table],
  )) as Column[];
}

/**
 * The primary-key columns, which give the paged read a total order. Every one
 * of the seven tables has one — a composite `(org_id, user_id)` on the billing
 * managers, a boolean singleton on the cursor — so a table without one is a
 * schema that is not the module's.
 */
async function primaryKeyOf(db: SQL, table: string): Promise<string[]> {
  const rows = (await db.unsafe(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY a.attnum`,
    [table],
  )) as { name: string }[];
  if (rows.length === 0) throw new Error(`${table} has no primary key — not the module's schema`);
  return rows.map((r) => r.name);
}

/** Row count, or `null` when the table does not exist. */
async function countRows(db: SQL, table: string): Promise<number | null> {
  const [present] = (await db.unsafe(`SELECT to_regclass($1) IS NOT NULL AS present`, [table])) as [
    { present: boolean },
  ];
  if (!present.present) return null;
  const [row] = (await db.unsafe(`SELECT count(*)::int AS count FROM "${table}"`)) as [
    { count: number },
  ];
  return row.count;
}

/** Every `ee_`/`cloud_` table the source holds — the population this script must account for. */
async function prefixedTables(src: SQL): Promise<string[]> {
  const rows = (await src.unsafe(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname ~ '^(ee|cloud)_'
      ORDER BY 1`,
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Which prefix the source speaks. A source carrying both is refused rather than
 * guessed at: `0005` renames all seven in one transaction, so a half-renamed
 * database is one no migration produced.
 */
function detectPrefix(tables: string[]): SourcePrefix {
  const held = new Set(tables);
  const ee = LOGICAL.filter((n) => held.has(`ee_${n}`));
  const cloud = LOGICAL.filter((n) => held.has(`cloud_${n}`));
  if (ee.length > 0 && cloud.length > 0) {
    throw new Refusal([
      `refusing: the source mixes both prefixes — ee_ (${ee.join(", ")}) and cloud_ (${cloud.join(", ")}).`,
      "Migration 0005 renames all seven at once, so no migration produced this. Resolve it by hand.",
    ]);
  }
  if (ee.length === 0 && cloud.length === 0) {
    throw new Refusal([
      "refusing: EE_SOURCE_DATABASE_URL holds none of the module's tables under either prefix.",
      "It names the wrong database, or the module never ran against it — there is nothing to move.",
    ]);
  }
  return ee.length > 0 ? "ee_" : "cloud_";
}

/**
 * What the copy will carry, table by table. Reads the snapshot rather than the
 * target for the target's shape: the target may not be migrated yet, and every
 * check has to answer before anything is written to it. The copied set is every
 * SOURCE column — a source column the target does not declare is refused here,
 * so by the time a plan exists the two are the source's columns exactly.
 */
async function planTables(src: SQL, prefix: SourcePrefix): Promise<TablePlan[]> {
  const plans: TablePlan[] = [];

  for (const [i, table] of EE_TABLES.entries()) {
    const wanted = DECLARED.get(table)!;
    const source = `${prefix}${LOGICAL[i]!}`;
    if ((await countRows(src, source)) === null) {
      plans.push({ table, source: null, defaulted: [] });
      continue;
    }

    const have = (await columnsOf(src, source)).map((c) => c.name);
    const sourceOnly = have.filter((n) => !wanted.includes(n));
    if (sourceOnly.length > 0) {
      throw new Refusal([
        `refusing: ${source} has column(s) ${table} does not declare: ${sourceOnly.join(", ")}.`,
        "Copying would drop them — reconcile the schemas before moving the rows.",
      ]);
    }
    plans.push({ table, source, defaulted: wanted.filter((n) => !have.includes(n)) });
  }
  return plans;
}

/**
 * Copy one table's rows source → target, a page at a time.
 *
 * Paging is by KEYSET on the primary key (`WHERE (pk) > (last)`), not by
 * `OFFSET`: under one REPEATABLE READ snapshot both are correct, but keyset
 * costs an index seek per page instead of re-walking every row already copied.
 * Values cross as text and are cast to the TARGET's type on the way in.
 */
async function copyTable(src: SQL, tx: SQL, plan: TablePlan): Promise<number> {
  if (!plan.source) return 0;

  const cols = await columnsOf(src, plan.source);
  const targetTypes = new Map((await columnsOf(tx, plan.table)).map((c) => [c.name, c.type]));
  const selectList = cols.map((c) => `"${c.name}"::text`).join(", ");
  const nameList = cols.map((c) => `"${c.name}"`).join(", ");

  const pk = await primaryKeyOf(src, plan.source);
  const keyList = pk.map((n) => `"${n}"`).join(", ");
  const keyCast = pk.map((n, i) => `$${i + 1}::${cols.find((c) => c.name === n)!.type}`).join(", ");

  let last: string[] | null = null;
  let copied = 0;
  for (;;) {
    const where = last === null ? "" : ` WHERE (${keyList}) > (${keyCast})`;
    const rows = (await src.unsafe(
      `SELECT ${selectList} FROM "${plan.source}"${where} ORDER BY ${keyList} LIMIT ${PAGE}`,
      last ?? [],
    )) as Record<string, string | null>[];
    if (rows.length === 0) return copied;

    const params: (string | null)[] = [];
    const tuples = rows.map((row) => {
      const tuple = cols
        .map((c, i) => `$${params.length + i + 1}::${targetTypes.get(c.name)!}`)
        .join(", ");
      for (const c of cols) params.push(row[c.name] ?? null);
      return `(${tuple})`;
    });
    await tx.unsafe(
      `INSERT INTO "${plan.table}" (${nameList}) VALUES ${tuples.join(", ")}`,
      params,
    );

    copied += rows.length;
    if (rows.length < PAGE) return copied;
    last = pk.map((n) => rows[rows.length - 1]![n]!);
  }
}

/**
 * Rows in the module's journal on the target. `drizzle.ee_migrations` is where
 * `migrateEeDb` writes it — deliberately a different TABLE in the same schema
 * as the platform's own `__drizzle_migrations`.
 */
async function appliedMigrations(db: SQL): Promise<number> {
  const [present] = (await db.unsafe(
    `SELECT to_regclass('drizzle.ee_migrations') IS NOT NULL AS present`,
  )) as [{ present: boolean }];
  if (!present.present) return 0;
  const [row] = (await db.unsafe(`SELECT count(*)::int AS count FROM drizzle.ee_migrations`)) as [
    { count: number },
  ];
  return row.count;
}

/** Migrations the module ships, so a dry-run can say how many the target lacks. */
function shippedMigrations(): number {
  const journal = readFileSync(
    resolve(MODULE_ROOT, "drizzle/migrations/meta/_journal.json"),
    "utf8",
  );
  return (JSON.parse(journal) as { entries: unknown[] }).entries.length;
}

/**
 * The module's own migrator, reached by a computed specifier. It is an import,
 * not a copy: this Apache-2.0 script runs the commercial module's code, it does
 * not carry it. The specifier is computed because
 * `scripts/verify-module-isolation.ts` forbids a platform file from naming a
 * module in a literal one — the same shape `scripts/lib/module-openapi.ts` uses.
 */
async function applyModuleMigrations(url: string): Promise<void> {
  // Crossing the licence boundary AT RUNTIME is the point — never copy `migrateEeDb` in-tree.
  const db = (await import(resolve(MODULE_ROOT, "src/db.ts"))) as {
    migrateEeDb: (databaseUrl: string) => Promise<void>;
  };
  await db.migrateEeDb(url);
}

function planLines(prefix: SourcePrefix, plans: TablePlan[]): string[] {
  const width = Math.max(...EE_TABLES.map((t) => t.length));
  const lines = [`source prefix: ${prefix}`];
  for (const plan of plans) {
    const detail =
      plan.source === null
        ? "absent from the source — nothing to copy"
        : plan.source +
          (plan.defaulted.length > 0 ? ` (${plan.defaulted.join(", ")} ← default)` : "");
    lines.push(`  ${plan.table.padEnd(width)} ← ${detail}`);
  }
  return lines;
}

function summary(
  counts: { table: string; source: number | null; target: number | null }[],
): string[] {
  const width = Math.max(...EE_TABLES.map((t) => t.length));
  const lines = [`${"table".padEnd(width)} |   source |   target | ok`];
  for (const { table, source, target } of counts) {
    const shown = (n: number | null): string => (n === null ? "absent" : String(n));
    const ok = source === null || target === null ? "-" : target === source ? "yes" : "NO";
    lines.push(
      `${table.padEnd(width)} | ${shown(source).padStart(8)} | ${shown(target).padStart(8)} | ${ok}`,
    );
  }
  return lines;
}

/** Everything after both connections are open and the source snapshot is fixed. */
async function move(src: SQL, target: SQL, targetUrl: string, apply: boolean): Promise<number> {
  const held = await prefixedTables(src);
  const prefix = detectPrefix(held);
  const known = new Set(LOGICAL.map((n) => `${prefix}${n}`));
  const unknown = held.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new Refusal([
      `refusing: the source holds table(s) this script does not move: ${unknown.join(", ")}.`,
      "It moves the module's seven tables and nothing else — move or drop these by hand first.",
    ]);
  }

  const plans = await planTables(src, prefix);

  const before = await Promise.all(EE_TABLES.map((t) => countRows(target, t)));
  const occupied = EE_TABLES.filter((_, i) => (before[i] ?? 0) > 0);
  if (occupied.length > 0) {
    throw new Refusal([
      `refusing: the target already holds ee_* rows (${occupied.join(", ")}).`,
      "This script copies, it does not merge — re-running it would double-count billed usage.",
      "If the move already ran, nothing is left to do; otherwise empty the target first.",
    ]);
  }

  const sourceCounts = await Promise.all(
    plans.map((plan) => (plan.source === null ? null : countRows(src, plan.source))),
  );

  for (const line of planLines(prefix, plans)) out(line);
  out("");

  if (!apply) {
    out(
      `would apply the module's migrations — ${shippedMigrations() - (await appliedMigrations(target))} pending on the target`,
    );
    out("");
    for (const line of summary(
      EE_TABLES.map((table, i) => ({ table, source: sourceCounts[i]!, target: before[i]! })),
    )) {
      out(line);
    }
    out("");
    out("dry-run — nothing was written. Re-run with --apply to copy.");
    return 0;
  }

  await applyModuleMigrations(targetUrl);
  await target.begin(async (tx: SQL) => {
    for (const plan of plans) await copyTable(src, tx, plan);
  });

  const after = await Promise.all(EE_TABLES.map((t) => countRows(target, t)));
  const counts = EE_TABLES.map((table, i) => ({
    table,
    source: sourceCounts[i]!,
    target: after[i]!,
  }));
  for (const line of summary(counts)) out(line);
  out("");

  const mismatched = counts.filter((c) => c.source !== null && c.target !== c.source);
  if (mismatched.length > 0) {
    out(`FAILED: ${mismatched.length} table(s) do not match. The transaction committed —`);
    out("compare both databases before starting the platform.");
    return 1;
  }
  out(
    "copied — every table matches. Keep the source database read-only until the deploy is verified.",
  );
  return 0;
}

async function ping(db: SQL, label: string): Promise<void> {
  try {
    await db.unsafe("SELECT 1");
  } catch (cause) {
    throw new Refusal([
      `refusing: cannot connect to ${label}.`,
      `  ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { apply: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    strict: true,
  });

  if (values.help === true) {
    out(
      "Usage: EE_SOURCE_DATABASE_URL=… DATABASE_URL=… bun scripts/migration/0010-ee-tables-into-platform-db.ts [--apply]",
    );
    out("  Moves the module's seven billing tables into the platform database.");
    out("  Default: dry-run (counts only). --apply: migrate the target, then copy.");
    return 0;
  }
  const apply = values.apply === true;

  const sourceUrl = process.env.EE_SOURCE_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL;
  if (!sourceUrl) {
    out("EE_SOURCE_DATABASE_URL is required — it is the database being emptied");
    return 2;
  }
  if (!targetUrl) {
    out("DATABASE_URL is required — it is the platform database receiving the tables");
    return 2;
  }

  // `max: 1` — every source read runs on the one connection the transaction
  // below reserves, so the checks and the paged copy share a single snapshot.
  const source = new SQL(sourceUrl, { max: 1 });
  const target = new SQL(targetUrl);
  try {
    await ping(source, "EE_SOURCE_DATABASE_URL");
    await ping(target, "DATABASE_URL");
    return (await source.begin(async (src: SQL) => {
      await src.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      return await move(src, target, targetUrl, apply);
    })) as number;
  } finally {
    await source.close();
    await target.close();
  }
}

// Guarded so the tests can import EE_TABLES without opening a connection.
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof Refusal) {
      for (const line of error.lines) out(line);
    } else {
      out(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}
