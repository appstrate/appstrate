/**
 * The gate that keeps data repair out of `drizzle/migrations/`.
 *
 * Ported from the platform's `scripts/test/verify-no-migration-dml.test.ts`
 * alongside the gate itself; the fixtures use cloud's tables, the assertions
 * use cloud's paths, and the cases are otherwise the same — the rule is the
 * same rule.
 *
 * Everything below runs on FIXTURES, never on the real directory. A gate
 * asserted against the tree it guards can only ever say "the tree is currently
 * clean" — which is what a gate that detects nothing says too. The fixtures
 * hold both directions: the shapes that must pass, and the shapes that must
 * fail.
 *
 * The two that matter most are the last pair. `passes` on a pure-DDL migration
 * proves nothing on its own (a detector wired to `return []` passes it), so it
 * is paired with a negative control — a fixture whose only difference is a real
 * `UPDATE`, asserted to fail. If both hold, the detector is discriminating
 * rather than silent.
 */

import { describe, it, expect } from "bun:test";
import {
  findDml,
  GRANDFATHERED,
  licencedTables,
  review,
  sanitize,
} from "../../scripts/verify-no-migration-dml.ts";

/** `findDml` reports at least one statement. */
const flags = (sql: string): boolean => findDml(sql).length > 0;

const PURE_DDL = `
ALTER TABLE "cloud_usage_records" ADD COLUMN "context_type" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_usage_records_context" ON "cloud_usage_records" USING btree ("context_type","context_id");--> statement-breakpoint
ALTER TABLE "cloud_billed_llm_usage" ADD CONSTRAINT "cloud_billed_llm_usage_org_id_fk" FOREIGN KEY ("org_id")
  REFERENCES "public"."cloud_billing_accounts"("org_id") ON DELETE cascade ON UPDATE no action;
`;

/** The negative control: `PURE_DDL` plus one row rewrite, and nothing else. */
const PURE_DDL_PLUS_UPDATE = `${PURE_DDL}--> statement-breakpoint
UPDATE "cloud_usage_records" SET "context_type" = 'run';
`;

describe("findDml — what must fail", () => {
  it("flags a bare UPDATE", () => {
    expect(
      flags(
        `UPDATE "cloud_billing_accounts" SET "subscription_status" = NULL WHERE "plan_id" = 'free';`,
      ),
    ).toBe(true);
  });

  it("flags a bare INSERT and a bare DELETE", () => {
    expect(flags(`INSERT INTO "cloud_billing_cursor" ("id") VALUES (true);`)).toBe(true);
    expect(flags(`DELETE FROM "cloud_usage_records" WHERE "org_id" IS NULL;`)).toBe(true);
  });

  it("flags an INSERT inside a DO $$ block with no constraint", () => {
    // The `$$` body is not a string literal to this gate — hiding a rewrite in
    // a PL/pgSQL block is the obvious way around a naive statement scanner,
    // and `0001` step 3 is exactly this shape.
    const sql = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "cloud_billing_accounts") THEN
    INSERT INTO "cloud_usage_records" ("context_type") VALUES ('run');
  END IF;
END $$;`;
    expect(flags(sql)).toBe(true);
  });

  it("reports the file's line number and the statement as written", () => {
    const sql = `-- header\n-- more header\nDELETE FROM "cloud_usage_records" WHERE "cost_credits" = 0;\n`;
    expect(findDml(sql)).toEqual([
      { line: 3, statement: `DELETE FROM "cloud_usage_records" WHERE "cost_credits" = 0;` },
    ]);
  });
});

describe("findDml — the constraint carve-out", () => {
  // `docs/NO_TRANSITIONAL_CODE.md` §2: the backfill is the precondition of the
  // constraint and cannot be separated from it, so it stays in the same file.
  // This is `0001` step 3 + step 4, reduced.
  it("allows an UPDATE beside a SET NOT NULL on the same table", () => {
    const sql = `UPDATE "cloud_usage_records" SET "context_type" = 'run' WHERE "context_id" IS NULL;--> statement-breakpoint
ALTER TABLE "cloud_usage_records" ALTER COLUMN "context_type" SET NOT NULL;`;
    expect(flags(sql)).toBe(false);
  });

  it("allows an UPDATE beside a CHECK on the same table", () => {
    const sql = `UPDATE "cloud_billing_accounts" SET "plan_id" = 'free' WHERE "plan_id" IS NULL;--> statement-breakpoint
ALTER TABLE "cloud_billing_accounts" ADD CONSTRAINT "cloud_billing_accounts_plan_valid" CHECK (plan_id IN ('free', 'starter', 'pro'));`;
    expect(flags(sql)).toBe(false);
  });

  it("allows an UPDATE beside a VALIDATE CONSTRAINT on the same table", () => {
    const sql = `UPDATE cloud_billed_llm_usage SET org_id = NULL WHERE org_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_billed_llm_usage" VALIDATE CONSTRAINT "cloud_billed_llm_usage_org_id_fk";`;
    expect(flags(sql)).toBe(false);
  });

  it("does NOT let a constraint on one table licence a rewrite of another", () => {
    // The bypass a future author reaches by accident: constrain table A, fold
    // rows on table B, gate green.
    const sql = `UPDATE "cloud_billing_accounts" SET "subscription_status" = NULL;--> statement-breakpoint
ALTER TABLE "cloud_billing_cursor" ADD CONSTRAINT "cloud_billing_cursor_single_row" CHECK ("cloud_billing_cursor"."id");`;
    expect(flags(sql)).toBe(true);
  });

  it("flags only the unlicenced statement when a file holds both", () => {
    const sql = `UPDATE "cloud_usage_records" SET "context_type" = 'run' WHERE "context_id" IS NULL;--> statement-breakpoint
ALTER TABLE "cloud_usage_records" ADD CONSTRAINT "k" CHECK (context_type IN ('run'));--> statement-breakpoint
DELETE FROM "cloud_billing_accounts" WHERE "plan_id" = 'free';`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toBe(
      `DELETE FROM "cloud_billing_accounts" WHERE "plan_id" = 'free';`,
    );
  });

  it("does NOT treat a column-definition NOT NULL as a promotion", () => {
    // `ADD COLUMN … NOT NULL` on a populated table needs a DEFAULT, and that
    // default already satisfies the constraint — no backfill was ever its
    // precondition. §2 licences the PROMOTION (`SET NOT NULL`), not this.
    // This is `0001`'s `cost_usd` pair, reduced: the exact shape the
    // table-level carve-out cannot separate from a real precondition, and the
    // reason `0001` is grandfathered rather than clean.
    const sql = `ALTER TABLE "cloud_usage_records" ADD COLUMN "cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "cloud_usage_records" SET "cost_usd" = "cost_credits" / 1000.0 WHERE "cost_usd" = 0 AND "cost_credits" > 0;`;
    expect(flags(sql)).toBe(true);
  });

  it("does NOT treat `IS NOT NULL` in a WHERE clause as adding a constraint", () => {
    const sql = `DELETE FROM "cloud_usage_records" WHERE "context_id" IS NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("matches tables across quoting, casing and schema qualification", () => {
    const sql = `UPDATE ONLY "public"."Cloud_Usage_Records" SET "c" = 1;--> statement-breakpoint
ALTER TABLE IF EXISTS public.cloud_usage_records ALTER COLUMN "c" SET NOT NULL;`;
    expect(flags(sql)).toBe(false);
  });

  it("fails closed when the DML target cannot be read", () => {
    const sql = `UPDATE 42 SET "c" = 1;--> statement-breakpoint
ALTER TABLE "cloud_usage_records" ALTER COLUMN "c" SET NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });
});

describe("licencedTables", () => {
  it("attributes each clause to its own ALTER TABLE", () => {
    const sql = `ALTER TABLE "a" ALTER COLUMN "c" SET NOT NULL;
ALTER TABLE "b" ADD CONSTRAINT "k" CHECK (c > 0);
ALTER TABLE "c" VALIDATE CONSTRAINT "k";`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set(["a", "b", "c"]));
  });

  it("attributes a clause nested in a DO block to the enclosing ALTER TABLE", () => {
    const sql = `DO $$
BEGIN
  ALTER TABLE "cloud_usage_records" ALTER COLUMN "context_id" SET NOT NULL;
END $$;`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set(["cloud_usage_records"]));
  });

  it("licences a CHECK written inside a CREATE TABLE", () => {
    // `0001` step 1 is this: the constraint arrives with the table, not by
    // `ALTER`, and it still names the table it lands on.
    const sql = `CREATE TABLE IF NOT EXISTS "cloud_billing_cursor" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  CONSTRAINT "cloud_billing_cursor_single_row" CHECK ("cloud_billing_cursor"."id")
);`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set(["cloud_billing_cursor"]));
  });

  it("licences nothing for a file that only defines columns", () => {
    const sql = `ALTER TABLE "cloud_usage_records" ADD COLUMN "cost_usd" double precision DEFAULT 0 NOT NULL;`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set());
  });
});

describe("findDml — CTE-led statements", () => {
  // `WITH … AS (DELETE … RETURNING *) INSERT INTO other …` is THE idiomatic
  // Postgres way to move rows between tables, and it passed this gate in
  // silence until `(` and `)` became boundaries.
  it("flags an UPDATE that follows a closing CTE paren", () => {
    const sql = `WITH stale AS (
  SELECT org_id FROM cloud_billing_accounts WHERE plan_id = 'free'
)
UPDATE cloud_billing_accounts SET credits_used = 0 WHERE org_id IN (SELECT org_id FROM stale);`;
    expect(flags(sql)).toBe(true);
  });

  it("flags a DELETE inside a CTE body and the INSERT it feeds", () => {
    const sql = `WITH moved AS (
  DELETE FROM cloud_pending_bills WHERE cost_credits = 0 RETURNING *
)
INSERT INTO cloud_usage_records SELECT * FROM moved;`;
    const findings = findDml(sql);
    expect(findings.map((f) => f.line)).toEqual([2, 4]);
  });

  it("flags a DML in the second body of a multi-CTE statement", () => {
    const sql = `WITH a AS (SELECT 1), b AS (DELETE FROM cloud_pending_bills RETURNING *)
SELECT * FROM b;`;
    expect(flags(sql)).toBe(true);
  });

  it("still ignores `ON DELETE` / `ON UPDATE` after a closing paren", () => {
    // The FK clause is the shape `)` had to be admitted without breaking:
    // `REFERENCES "cloud_billing_accounts"("org_id") ON DELETE cascade` puts a
    // `)` a few tokens before the keyword, but `ON` is what directly precedes it.
    const sql = `ALTER TABLE "cloud_billed_llm_usage" ADD CONSTRAINT "fk" FOREIGN KEY ("org_id")
  REFERENCES "public"."cloud_billing_accounts"("org_id") ON DELETE cascade ON UPDATE no action;`;
    expect(flags(sql)).toBe(false);
  });

  it("does not double-count `DO UPDATE SET` in an ON CONFLICT clause", () => {
    // The enclosing INSERT is already a finding on its own keyword; the
    // `UPDATE` in the conflict action must not add a second one.
    const sql = `INSERT INTO "cloud_billing_cursor" ("id") VALUES (true)
  ON CONFLICT ("id") DO UPDATE SET "id" = excluded."id";`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toStartWith(`INSERT INTO "cloud_billing_cursor"`);
  });

  it("does not treat a privilege list as two statements", () => {
    // `,` is deliberately not a boundary: `GRANT INSERT, UPDATE` grants a
    // right, it does not write a row.
    expect(flags(`GRANT INSERT, UPDATE ON "cloud_usage_records" TO "cloud";`)).toBe(false);
  });
});

describe("findDml — TRUNCATE", () => {
  it("flags a bare TRUNCATE", () => {
    expect(flags(`TRUNCATE TABLE "cloud_usage_records";`)).toBe(true);
    expect(flags(`TRUNCATE "cloud_usage_records";`)).toBe(true);
    expect(flags(`TRUNCATE ONLY "cloud_usage_records" RESTART IDENTITY CASCADE;`)).toBe(true);
  });

  it("flags a TRUNCATE even when the same table gains a constraint", () => {
    // Emptying a table satisfies every constraint vacuously. Licencing that
    // would let "drop all rows, then promote the column" through the gate.
    const sql = `TRUNCATE TABLE "cloud_usage_records";--> statement-breakpoint
ALTER TABLE "cloud_usage_records" ALTER COLUMN "context_type" SET NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("flags every table of a comma-separated TRUNCATE through one finding", () => {
    const findings = findDml(
      `TRUNCATE "cloud_usage_records", "cloud_billed_llm_usage", "cloud_billing_cursor";`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toBe(
      `TRUNCATE "cloud_usage_records", "cloud_billed_llm_usage", "cloud_billing_cursor";`,
    );
  });

  it("ignores TRUNCATE inside a comment or a literal", () => {
    expect(
      flags(
        `-- we used to TRUNCATE "cloud_usage_records" here\nALTER TABLE "cloud_usage_records" ADD COLUMN "c" text;`,
      ),
    ).toBe(false);
  });
});

describe("findDml — writes deliberately outside the vocabulary", () => {
  // Documented on `licencedTables`: excluded on purpose, not overlooked. These
  // cases pin the decision so a future change to it is visible in the diff.
  it("does not flag `SELECT … INTO`", () => {
    expect(flags(`SELECT * INTO cloud_usage_backup FROM cloud_usage_records;`)).toBe(false);
  });

  it("does not flag a PL/pgSQL `SELECT … INTO` variable assignment", () => {
    const sql = `DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "cloud_usage_records";
END $$;`;
    expect(flags(sql)).toBe(false);
  });

  it("does not flag `COPY … FROM`", () => {
    expect(flags(`COPY cloud_usage_records (org_id) FROM '/tmp/x.csv';`)).toBe(false);
  });
});

describe("findDml — what is not a statement", () => {
  it("ignores DML keywords in a `--` comment", () => {
    const sql = `-- This migration used to UPDATE every row, and an INSERT was
-- considered. We DELETE nothing now.
ALTER TABLE "cloud_usage_records" ADD COLUMN "note" text;`;
    expect(flags(sql)).toBe(false);
  });

  it("ignores DML keywords in a block comment and in a string literal", () => {
    const sql = `/* DELETE FROM "cloud_usage_records" was the old plan */
ALTER TABLE "cloud_usage_records" ALTER COLUMN "note" SET DEFAULT 'INSERT INTO nothing';`;
    expect(flags(sql)).toBe(false);
  });

  it("ignores `ON DELETE` / `ON UPDATE` foreign-key actions", () => {
    const sql = `ALTER TABLE "cloud_billed_llm_usage" ADD CONSTRAINT "fk" FOREIGN KEY ("org_id")
  REFERENCES "public"."cloud_billing_accounts"("org_id") ON DELETE cascade ON UPDATE no action;`;
    expect(flags(sql)).toBe(false);
  });

  it("ignores identifiers that merely start with a keyword", () => {
    const sql = `CREATE INDEX "idx_cloud_usage_records_updated" ON "cloud_usage_records" USING btree ("updated_at", "inserted_by");`;
    expect(flags(sql)).toBe(false);
  });
});

describe("findDml — the pure-DDL pass and its negative control", () => {
  it("passes a pure-DDL migration", () => {
    expect(findDml(PURE_DDL)).toEqual([]);
  });

  it("fails the same migration once one UPDATE is added", () => {
    // If this did not fail, the case above would be proving nothing.
    const findings = findDml(PURE_DDL_PLUS_UPDATE);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toBe(`UPDATE "cloud_usage_records" SET "context_type" = 'run';`);
  });
});

describe("review", () => {
  const grandfathered = GRANDFATHERED[0]!;
  const offending = `UPDATE "cloud_billing_accounts" SET "subscription_status" = NULL;`;
  const present = new Map(GRANDFATHERED.map((name) => [name, offending]));

  it("passes a grandfathered file that rewrites rows", () => {
    expect(review(present)).toEqual([]);
  });

  it("fails the identical content under any other name", () => {
    // Same bytes, different filename — the exemption is a list of files, not a
    // property of the SQL.
    const problems = review(new Map([...present, ["9999_new_migration", offending]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "drizzle/migrations/9999_new_migration.sql rewrites row contents",
    );
    expect(problems[0]).toContain("scripts/migration");
  });

  it("points the author at `scripts/migration/`", () => {
    const problems = review(new Map([...present, ["9999_new_migration", offending]]));
    expect(problems[0]).toContain("scripts/migration/");
  });

  it("fails when a GRANDFATHERED entry names no migration", () => {
    const missing = new Map(present);
    missing.delete(grandfathered);
    const problems = review(missing);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(grandfathered);
    expect(problems[0]).toContain("not in drizzle/migrations/");
  });
});

describe("sanitize", () => {
  it("preserves byte offsets and line breaks", () => {
    const sql = `-- comment\nSELECT 'literal';\n`;
    const out = sanitize(sql);
    expect(out).toHaveLength(sql.length);
    expect(out.split("\n")).toHaveLength(sql.split("\n").length);
    expect(out).toContain("SELECT");
    expect(out).not.toContain("literal");
    expect(out).not.toContain("comment");
  });

  it("turns `--> statement-breakpoint` into a statement boundary", () => {
    // It is a comment, so blanking it would erase the very separator drizzle
    // uses — and every statement after the first would read as a continuation.
    const out = sanitize(`SELECT 1--> statement-breakpoint\nSELECT 2`);
    expect(out).toContain(";");
  });

  it("does not blank a `''` escaped quote as a terminator", () => {
    const out = sanitize(`SELECT 'it''s here', "kept";`);
    expect(out).toContain("kept");
    expect(out).not.toContain("here");
  });
});
