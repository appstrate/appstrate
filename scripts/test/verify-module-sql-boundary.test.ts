// SPDX-License-Identifier: Apache-2.0

/**
 * The gate that gives `apps/api/src/modules/README.md` rule 4 — "never a SQL
 * join across the licence boundary" — something other than prose behind it.
 *
 * The defect it exists for is invisible to every other check: because
 * `@appstrate/module-ee` migrates its tables into the PLATFORM database, a
 * `SELECT … FROM organizations` written in the module compiles, runs, returns
 * rows and passes typecheck, lint, knip, the isolation gate and the test suite.
 * So the positive control below is that exact statement, and it must FAIL.
 */

import { describe, it, expect } from "bun:test";
import {
  findTableReferences,
  isSystemRelation,
  reviewModuleSnapshot,
  reviewModuleSql,
  sqlText,
  type ScannedFile,
} from "../verify-module-sql-boundary.ts";

/** The seven `ee_*` tables the module's snapshot declares, in miniature. */
const OWN = new Set(["ee_billing_accounts", "ee_usage_records"]);

const file = (source: string, name = "packages/module-ee/src/billing/x.ts"): ScannedFile[] => [
  { file: name, source },
];

describe("reviewModuleSql — raw SQL naming a platform table", () => {
  it("POSITIVE CONTROL: fails on `FROM organizations`, naming the file and the table", () => {
    // The whole reason this gate exists. Nothing else in `bun run check` says a
    // word about this statement.
    const { problems } = reviewModuleSql(
      "ee",
      file("const q = sql`SELECT id FROM organizations WHERE id = 1`;"),
      OWN,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("packages/module-ee/src/billing/x.ts:1");
    expect(problems[0]).toContain("`organizations`");
    expect(problems[0]).toContain("does not own");
  });

  it("NEGATIVE CONTROL: passes on the same statement against one of its own tables", () => {
    const { problems, references } = reviewModuleSql(
      "ee",
      file("const q = sql`SELECT id FROM ee_usage_records`;"),
      OWN,
    );
    expect(problems).toEqual([]);
    expect(references).toBe(1);
  });

  it("catches a JOIN, an INSERT INTO, an UPDATE and a DELETE FROM alike", () => {
    const { problems } = reviewModuleSql(
      "ee",
      file(
        [
          "const a = sql`SELECT 1 FROM ee_usage_records JOIN llm_usage USING (id)`;",
          'const b = sql.raw("INSERT INTO audit_events (id) VALUES (1)");',
          "const c = sql`UPDATE organizations SET name = 'x'`;",
          'const d = await db.execute("DELETE FROM api_keys");',
        ].join("\n"),
      ),
      OWN,
    );
    expect(problems.map((p) => p.match(/table `(\w+)`/)?.[1])).toEqual([
      "llm_usage",
      "audit_events",
      "organizations",
      "api_keys",
    ]);
    expect(problems[0]).toContain(":1");
    expect(problems[3]).toContain(":4");
  });

  it("allows the catalog relations any module may read", () => {
    const { problems } = reviewModuleSql(
      "ee",
      file(
        "const a = sql`SELECT 1 FROM pg_indexes`;\n" +
          "const b = sql`SELECT 1 FROM information_schema.columns`;\n" +
          "const c = sql`SELECT 1 FROM drizzle.ee_migrations`;\n",
      ),
      OWN,
    );
    expect(problems).toEqual([]);
  });

  it("reads a `public.`-qualified own table as its own", () => {
    const { problems } = reviewModuleSql(
      "ee",
      file('const q = sql`SELECT 1 FROM public."ee_billing_accounts"`;'),
      OWN,
    );
    expect(problems).toEqual([]);
  });
});

describe("reviewModuleSql — the platform schema import", () => {
  it("POSITIVE CONTROL: fails on a bare `@appstrate/db` import", () => {
    // The other half of the same defect, and the half raw-SQL scanning cannot
    // see: `.from(organizations)` names no table in any string.
    const { problems } = reviewModuleSql(
      "ee",
      file('import { organizations } from "@appstrate/db/schema";'),
      OWN,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@appstrate/db/schema");
    expect(problems[0]).toContain("licence boundary");
  });

  it("fails on a relative import reaching into packages/db", () => {
    const { problems } = reviewModuleSql(
      "ee",
      file('import { runs } from "../../../packages/db/src/schema/runs.ts";'),
      OWN,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("packages/db");
  });

  it("NEGATIVE CONTROL: leaves the module's own imports and core alone", () => {
    const { problems } = reviewModuleSql(
      "ee",
      file(
        'import { getEeDb } from "../db.ts";\n' +
          'import { logger } from "@appstrate/core/logger";\n' +
          'import * as schema from "../../drizzle/schema.ts";\n',
      ),
      OWN,
    );
    expect(problems).toEqual([]);
  });

  it("does not mistake `@appstrate/dbx` for the platform schema", () => {
    const { problems } = reviewModuleSql("ee", file('import x from "@appstrate/dbx";'), OWN);
    expect(problems).toEqual([]);
  });
});

describe("sqlText — what survives the blanking", () => {
  it("blanks comments, so prose about a platform table is not a query", () => {
    const { problems } = reviewModuleSql(
      "ee",
      file("// never write SELECT * FROM organizations here\n/* nor FROM llm_usage */\n"),
      OWN,
    );
    expect(problems).toEqual([]);
  });

  it("blanks a string that is not SQL, so a log message is not a query", () => {
    const { problems, literals } = reviewModuleSql(
      "ee",
      file('logger.info("copied FROM organizations into the ledger");'),
      OWN,
    );
    expect(problems).toEqual([]);
    expect(literals).toBe(0);
  });

  it("blanks `${…}` interpolations, including nested braces and templates", () => {
    // `FROM ${orgUsageRecords}` is how the module's one real `FROM` is written:
    // the identifier is a drizzle object, not a name this scan can read. What it
    // would be if it were a PLATFORM table object, the import rule catches.
    const out = sqlText("const q = sql`SELECT ${a ? `${b}` : { c: 1 }} FROM ${t} WHERE x`;");
    expect(out.literals).toBe(1);
    expect(out.text).toContain("SELECT");
    expect(out.text).not.toContain("b");
    expect(findTableReferences(out.text)).toEqual([]);
  });

  it("keeps byte offsets, so a line number is the real one", () => {
    const source = "// c\n\nconst q = sql`SELECT 1 FROM organizations`;\n";
    expect(sqlText(source).text).toHaveLength(source.length);
    expect(findTableReferences(sqlText(source).text)).toEqual([
      { table: "organizations", line: 3 },
    ]);
  });

  it("survives a regex literal holding an unbalanced quote", () => {
    // Without regex handling the `'` inside opens a string literal that blanks
    // the rest of the file — the SQL below would vanish and the gate would pass.
    const source = "const re = /it's/;\nconst q = sql`SELECT 1 FROM organizations`;\n";
    expect(findTableReferences(sqlText(source).text)).toEqual([
      { table: "organizations", line: 2 },
    ]);
  });
});

describe("findTableReferences — what is not a table", () => {
  it("ignores `DO UPDATE SET`, the shape every upsert in the module uses", () => {
    const sql = sqlText(
      "const q = sql`INSERT INTO ee_usage_records VALUES (1) ON CONFLICT DO UPDATE SET x = 1`;",
    );
    expect(findTableReferences(sql.text)).toEqual([{ table: "ee_usage_records", line: 1 }]);
  });

  it("ignores a set-returning function, which is a call and not a relation", () => {
    const sql = sqlText("const q = sql`SELECT 1 FROM generate_series(1, 10)`;");
    expect(findTableReferences(sql.text)).toEqual([]);
  });
});

describe("reviewModuleSnapshot", () => {
  it("POSITIVE CONTROL: refuses a journal whose snapshot declares no table", () => {
    // With nothing owned, `isOwnTable` answers false for everything and every
    // finding above becomes a problem — but the scan never gets that far: it is
    // the SNAPSHOT that is broken, and a gate checking a module against an empty
    // set of its own tables is checking nothing.
    const problem = reviewModuleSnapshot({
      id: "ee",
      snapshot: "packages/module-ee/drizzle/migrations/meta/0003_snapshot.json",
      tables: new Set(),
    });
    expect(problem).toContain("0003_snapshot.json");
    expect(problem).toContain("declares zero");
    expect(problem).toContain("vacuously");
  });

  it("NEGATIVE CONTROL: says nothing about a snapshot that declares one", () => {
    expect(
      reviewModuleSnapshot({ id: "ee", snapshot: "x/0003_snapshot.json", tables: OWN }),
    ).toBeNull();
  });
});

describe("isSystemRelation", () => {
  it("accepts the catalogs and the journal schema, and nothing else", () => {
    expect(isSystemRelation("pg_indexes")).toBe(true);
    expect(isSystemRelation("pg_catalog.pg_class")).toBe(true);
    expect(isSystemRelation("information_schema.tables")).toBe(true);
    expect(isSystemRelation("drizzle.ee_migrations")).toBe(true);
    expect(isSystemRelation("organizations")).toBe(false);
    expect(isSystemRelation("public.organizations")).toBe(false);
  });
});

describe("the real tree", () => {
  it("NEGATIVE CONTROL: the gate passes over this repository", async () => {
    const proc = Bun.spawn(["bun", "scripts/verify-module-sql-boundary.ts"], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    // The scan must be seen to have READ something: a module with zero raw-SQL
    // literals and a scanner that no longer recognises one print the same
    // "0 table reference(s)".
    expect(out).toContain("module SQL boundary clean");
    expect(out).not.toContain("0 raw-SQL literal(s) read");
  });
});
