// SPDX-License-Identifier: Apache-2.0

/**
 * Migration replay vs. declared schema — the CATALOG, not the snapshot.
 *
 * `migration-index-parity.test.ts` is the sibling of this file and covers a
 * different half: it asserts the replayed database has every index the latest
 * drizzle SNAPSHOT declares. That catches a snapshot entry no SQL creates, and
 * nothing else — the snapshot and the TS schema are written by the same
 * `db:generate` invocation, so they agree by construction and neither is
 * evidence about the database.
 *
 * This file asks the other question: does the DATABASE the journal builds have
 * the shape `packages/db/src/schema/` declares? Both sides are read from the
 * artefacts that actually ship — `getTableConfig()` on the TS schema, and
 * `pg_catalog` on a throwaway PGlite the whole journal was replayed into. No
 * snapshot is consulted at all.
 *
 * ═══ WHAT THIS CATCHES THAT NOTHING ELSE DOES ═══
 *
 * The defect it was written for: `foreignKey` names past Postgres'
 * NAMEDATALEN-1 = 63-byte identifier limit. Two of them —
 * `integration_org_defaults_connection_id_integration_connections_id_fk` (68)
 * and `model_provider_pairings_credential_id_model_provider_credentials_id_fk`
 * (70) — were declared in the schema, written into every snapshot, and emitted
 * verbatim by `0000_init.sql`, while the catalog held only the silently
 * TRUNCATED forms. Postgres truncates at creation without a warning, so the
 * DDL succeeds and every tool in this repo reports agreement:
 *
 *   - `drizzle-kit generate` compares the schema to the snapshot. Both carry
 *     the 70-byte name, so there is no drift to report.
 *   - `scripts/check-index-drift.ts` compares INDEX NAMES ONLY, against a LIVE
 *     `DATABASE_URL`. It cannot see a constraint, and it cannot run in `check`.
 *   - `migration-index-parity.test.ts` compares indexes to the snapshot.
 *   - the whole suite passes, because the FK works perfectly. Only its NAME is
 *     wrong, and nothing addresses a constraint by name until something does.
 *
 * What eventually does is drizzle-kit itself: change either FK's `onDelete` or
 * its target and `generate` emits `DROP CONSTRAINT "<the declared name>"`,
 * which matches nothing, errors 42704, and aborts the whole pending batch —
 * every migration in that release, on every database. That is the beta.24
 * failure mode (`audit_events_org_id_fkey` vs `…_organizations_id_fk`),
 * reached from a different direction.
 *
 * The `identifiers stay inside Postgres' 63-byte limit` case below is therefore
 * not a style rule. It is the only check in the repo that fails at the commit
 * that introduces such a name, rather than at the deploy that trips over it.
 *
 * ═══ WHY BOTH DIRECTIONS ═══
 *
 * Every comparison is a full set diff, not a one-way containment. A migration
 * that creates something the schema does not declare is the same class of
 * defect as a schema that declares something no migration creates — the
 * database and the code disagree — and only the second is even theoretically
 * visible to drizzle-kit.
 *
 * ═══ WHAT IS DELIBERATELY OUT OF SCOPE ═══
 *
 * - Tables Better Auth or a module creates outside `schema/` (there are none
 *   today, and the diff is scoped to DECLARED tables so a future one is not a
 *   false red).
 * - CHECK constraint BODIES. Postgres re-renders an expression from its parse
 *   tree (`'x'::text`, parenthesisation, `= ANY (ARRAY[…])` for `IN`), so a
 *   textual comparison against the schema's `sql` template is noise. Names are
 *   compared, which is what a `DROP CONSTRAINT` needs.
 * - Index column ORDER beyond the leading column, and partial predicates.
 *   Those are `check-index-drift.ts`'s stated gap and are fiddly to render
 *   comparably; the leading column is asserted because it is what decides
 *   whether an index can serve a seek at all.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@appstrate/db/schema";
import { applyCorePGliteMigrations } from "../../src/lib/pglite-migrate.ts";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../../packages/db/drizzle");

/** Postgres' NAMEDATALEN - 1. An identifier past this is truncated at creation. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Own throwaway database, not the suite's shared PGlite: this file must build
 * its subject from the migrations alone, so it cannot borrow a database whose
 * shape someone else already decided.
 */
const pg = new PGlite();

interface DeclaredTable {
  name: string;
  /** column name → NOT NULL */
  columns: Map<string, boolean>;
  /** constraint name → `f` (foreign key) | `c` (check) | `u` (unique) | `p` (primary key) */
  constraints: Map<string, string>;
  /** index name → leading column expression */
  indexes: Map<string, string>;
}

const declared = new Map<string, DeclaredTable>();

function declaredTables(): Map<string, DeclaredTable> {
  const tables = new Map<string, DeclaredTable>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value as PgTable);
    const columns = new Map<string, boolean>();
    for (const column of config.columns) columns.set(column.name, column.notNull);

    const constraints = new Map<string, string>();
    for (const fk of config.foreignKeys) constraints.set(fk.getName(), "f");
    for (const check of config.checks) constraints.set(check.name, "c");
    for (const unique of config.uniqueConstraints) {
      // Drizzle types the name optional and derives `<table>_<cols>_unique`
      // when it is omitted; every one here is named, so the fallback exists to
      // keep the comparison total rather than to describe today's schema.
      constraints.set(
        unique.name ?? `${config.name}_${unique.columns.map((c) => c.name).join("_")}_unique`,
        "u",
      );
    }
    for (const pk of config.primaryKeys) constraints.set(pk.getName(), "p");
    // A column-level `.unique()` produces no entry in `uniqueConstraints`
    // either — drizzle keeps it on the column and derives
    // `<table>_<column>_unique` when it renders the DDL.
    for (const column of config.columns) {
      if (!column.isUnique) continue;
      constraints.set(column.uniqueName ?? `${config.name}_${column.name}_unique`, "u");
    }
    // A single-column `.primaryKey()` produces no entry in `primaryKeys`; the
    // catalog still holds a `<table>_pkey`, and Postgres names it that way.
    if (config.primaryKeys.length === 0 && config.columns.some((column) => column.primary)) {
      constraints.set(`${config.name}_pkey`, "p");
    }

    const indexes = new Map<string, string>();
    for (const index of config.indexes) {
      // Drizzle types the index name optional (a bare `index()` lets Postgres
      // pick). Nothing here does that, and an unnamed index has no name to
      // compare, so it is skipped rather than guessed at.
      const indexName = index.config.name;
      if (!indexName) continue;
      const first = index.config.columns[0];
      if (!first) continue;
      // A plain column reference exposes `.name`; an expression index (e.g.
      // `pkp_key_unique`'s COALESCE) does not, and is compared by name only.
      const leading = "name" in first && typeof first.name === "string" ? first.name : "";
      indexes.set(indexName, leading);
    }

    tables.set(config.name, { name: config.name, columns, constraints, indexes });
  }
  return tables;
}

/**
 * First indexed column of a `pg_indexes.indexdef`.
 *
 * The rendering is `CREATE [UNIQUE] INDEX <name> ON <table> USING <method>
 * (<cols>) [WHERE (<predicate>)]`, and both the column list and the predicate
 * are parenthesised — so the closing paren has to be found by BALANCE, not by
 * `indexOf(")")`, or a `COALESCE(a, b)` first column truncates mid-call. The
 * per-column suffixes Postgres appends (`DESC`, `NULLS FIRST`, an opclass) are
 * dropped: this compares which column leads, not how it is sorted.
 */
function leadingIndexedColumn(definition: string): string {
  const open = definition.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  let end = definition.length;
  for (let i = open; i < definition.length; i++) {
    const char = definition[i];
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) {
      end = i;
      break;
    }
  }
  let split = end;
  depth = 0;
  for (let i = open + 1; i < end; i++) {
    const char = definition[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      split = i;
      break;
    }
  }
  return definition
    .slice(open + 1, split)
    .trim()
    .split(/\s+/)[0]!
    .replace(/^"|"$/g, "");
}

/** `a - b`, sorted, so an expectation failure prints the missing members. */
function missing(a: Iterable<string>, b: ReadonlySet<string> | Map<string, unknown>): string[] {
  const has = (key: string) => ("has" in b ? b.has(key) : false);
  return [...a].filter((key) => !has(key)).sort();
}

beforeAll(async () => {
  await applyCorePGliteMigrations(MIGRATIONS_DIR, pg);
  for (const [name, table] of declaredTables()) declared.set(name, table);
});

afterAll(async () => {
  await pg.close();
});

describe("migration replay schema parity", () => {
  it("declares at least the tables the replay builds", () => {
    // Guard on the fixture itself: every assertion below is scoped to the
    // declared set, so an empty or half-loaded schema barrel would make the
    // whole file vacuously green.
    expect(declared.size).toBeGreaterThan(40);
  });

  it("creates every declared table", async () => {
    const { rows } = await pg.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const actual = new Set(rows.map((row) => row.tablename));
    expect(missing(declared.keys(), actual)).toEqual([]);
  });

  it("creates every declared column, and no undeclared one", async () => {
    const { rows } = await pg.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    const actual = new Map<string, Map<string, boolean>>();
    for (const row of rows) {
      if (!declared.has(row.table_name)) continue;
      let columns = actual.get(row.table_name);
      if (!columns) actual.set(row.table_name, (columns = new Map()));
      columns.set(row.column_name, row.is_nullable === "NO");
    }

    const absent: string[] = [];
    const undeclared: string[] = [];
    const nullability: string[] = [];
    for (const [name, table] of declared) {
      const columns = actual.get(name) ?? new Map<string, boolean>();
      for (const [column, notNull] of table.columns) {
        if (!columns.has(column)) absent.push(`${name}.${column}`);
        else if (columns.get(column) !== notNull) nullability.push(`${name}.${column}`);
      }
      for (const column of columns.keys()) {
        if (!table.columns.has(column)) undeclared.push(`${name}.${column}`);
      }
    }
    expect(absent).toEqual([]);
    expect(undeclared).toEqual([]);
    expect(nullability).toEqual([]);
  });

  it("creates every declared constraint UNDER ITS DECLARED NAME, and no undeclared one", async () => {
    // The identifier-limit case. A declared name past 63 bytes is present in
    // the catalog only in truncated form, so it shows up here as one entry in
    // `absent` and one in `undeclared` — the two halves of the same defect.
    //
    // `contype` is filtered to the four kinds the schema can declare. Postgres
    // also records NOT NULL in `pg_constraint` (`contype = 'n'`), under names
    // no schema ever writes; nullability is compared column-wise above.
    const { rows } = await pg.query<{ relname: string; conname: string; contype: string }>(
      `SELECT t.relname, c.conname, c.contype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND c.contype IN ('f', 'c', 'u', 'p')`,
    );
    const actual = new Map<string, Map<string, string>>();
    for (const row of rows) {
      if (!declared.has(row.relname)) continue;
      let constraints = actual.get(row.relname);
      if (!constraints) actual.set(row.relname, (constraints = new Map()));
      constraints.set(row.conname, row.contype);
    }

    const absent: string[] = [];
    const undeclared: string[] = [];
    const wrongKind: string[] = [];
    for (const [name, table] of declared) {
      const constraints = actual.get(name) ?? new Map<string, string>();
      for (const [constraint, kind] of table.constraints) {
        if (!constraints.has(constraint)) absent.push(`${name}.${constraint}`);
        else if (constraints.get(constraint) !== kind) wrongKind.push(`${name}.${constraint}`);
      }
      for (const constraint of constraints.keys()) {
        // A UNIQUE declared as `uniqueIndex()` rather than `unique()` is an
        // index in the schema and a constraint-backed index in neither — it
        // has no `pg_constraint` row, so it cannot appear here. The reverse
        // (a catalog constraint the schema does not declare) is real drift.
        if (!table.constraints.has(constraint)) undeclared.push(`${name}.${constraint}`);
      }
    }
    expect(absent).toEqual([]);
    expect(undeclared).toEqual([]);
    expect(wrongKind).toEqual([]);
  });

  it("gives every declared foreign key the declared ON DELETE action", async () => {
    // The half a name comparison cannot see. `audit_events.space_id` carried
    // `ON DELETE SET NULL` under a perfectly ordinary name, and blanked the
    // audit trail of every deleted space.
    const { rows } = await pg.query<{ relname: string; conname: string; confdeltype: string }>(
      `SELECT t.relname, c.conname, c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND c.contype = 'f'`,
    );
    const actions: Record<string, string> = {
      a: "no action",
      r: "restrict",
      c: "cascade",
      n: "set null",
      d: "set default",
    };
    const actual = new Map<string, string>();
    for (const row of rows) {
      actual.set(`${row.relname}.${row.conname}`, actions[row.confdeltype] ?? row.confdeltype);
    }

    const mismatched: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value as PgTable);
      for (const fk of config.foreignKeys) {
        const key = `${config.name}.${fk.getName()}`;
        // Drizzle leaves `onDelete` undefined for the Postgres default.
        const expected = fk.onDelete ?? "no action";
        const found = actual.get(key);
        if (found !== undefined && found !== expected) {
          mismatched.push(`${key}: catalog says ${found}, schema declares ${expected}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("creates every declared index, on the declared leading column", async () => {
    // The leading column is the whole question for a cascade or a delete-by-X:
    // an index whose first column is not the one the query filters cannot serve
    // a seek, and the statement falls back to a sequential scan inside whatever
    // transaction is holding a lock at the time (migrations 0050 and 0055).
    const { rows } = await pg.query<{ tablename: string; indexname: string; indexdef: string }>(
      "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'",
    );
    const actual = new Map<string, string>();
    for (const row of rows) actual.set(`${row.tablename}.${row.indexname}`, row.indexdef);

    const absent: string[] = [];
    const wrongLeadingColumn: string[] = [];
    for (const [name, table] of declared) {
      for (const [index, leading] of table.indexes) {
        const definition = actual.get(`${name}.${index}`);
        if (definition === undefined) {
          absent.push(`${name}.${index}`);
          continue;
        }
        if (!leading) continue; // expression index — name-only comparison
        const first = leadingIndexedColumn(definition);
        if (first !== leading) {
          wrongLeadingColumn.push(
            `${name}.${index}: leads on ${first}, schema declares ${leading}`,
          );
        }
      }
    }
    expect(absent).toEqual([]);
    expect(wrongLeadingColumn).toEqual([]);
  });

  it("keeps every declared identifier inside Postgres' 63-byte limit", () => {
    // Read the file header. This is the case the whole file exists for, and it
    // is asserted on the DECLARED name, because the catalog cannot report it:
    // Postgres truncates silently at creation, so by the time a name reaches
    // `pg_constraint` the evidence is gone.
    const overlong: string[] = [];
    for (const [name, table] of declared) {
      for (const identifier of [...table.constraints.keys(), ...table.indexes.keys()]) {
        const bytes = Buffer.byteLength(identifier, "utf8");
        if (bytes > MAX_IDENTIFIER_BYTES) overlong.push(`${name}.${identifier} (${bytes} bytes)`);
      }
      const bytes = Buffer.byteLength(name, "utf8");
      if (bytes > MAX_IDENTIFIER_BYTES) overlong.push(`${name} (${bytes} bytes)`);
    }
    expect(overlong).toEqual([]);
  });
});
