// SPDX-License-Identifier: Apache-2.0

/**
 * The gate that keeps data repair out of `packages/db/drizzle/`.
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
} from "../verify-no-migration-dml.ts";

/** `findDml` reports at least one statement. */
const flags = (sql: string): boolean => findDml(sql).length > 0;

const PURE_DDL = `
ALTER TABLE "runs" ADD COLUMN "version_ref" text;--> statement-breakpoint
CREATE INDEX "idx_runs_version_ref" ON "runs" USING btree ("version_ref");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_fk" FOREIGN KEY ("org_id")
  REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
`;

/** The negative control: `PURE_DDL` plus one row rewrite, and nothing else. */
const PURE_DDL_PLUS_UPDATE = `${PURE_DDL}--> statement-breakpoint
UPDATE "runs" SET "version_ref" = 'draft';
`;

describe("findDml — what must fail", () => {
  it("flags a bare UPDATE", () => {
    expect(flags(`UPDATE "runs" SET "status" = 'failed' WHERE "status" = 'pending';`)).toBe(true);
  });

  it("flags a bare INSERT and a bare DELETE", () => {
    expect(flags(`INSERT INTO "orgs" ("id", "name") VALUES ('o1', 'acme');`)).toBe(true);
    expect(flags(`DELETE FROM "application_packages" WHERE "org_id" IS NULL;`)).toBe(true);
  });

  it("flags an INSERT inside a DO $$ block with no constraint", () => {
    // The `$$` body is not a string literal to this gate — hiding a rewrite in
    // a PL/pgSQL block is the obvious way around a naive statement scanner.
    const sql = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orgs") THEN
    INSERT INTO "audit_events" ("kind") VALUES ('backfill');
  END IF;
END $$;`;
    expect(flags(sql)).toBe(true);
  });

  it("reports the file's line number and the statement as written", () => {
    const sql = `-- header\n-- more header\nDELETE FROM "runs" WHERE "status" = 'pending';\n`;
    expect(findDml(sql)).toEqual([
      { line: 3, statement: `DELETE FROM "runs" WHERE "status" = 'pending';` },
    ]);
  });
});

describe("findDml — the constraint carve-out", () => {
  // `docs/NO_TRANSITIONAL_CODE.md` §2: the backfill is the precondition of the
  // constraint and cannot be separated from it, so it stays in the same file.
  it("allows an UPDATE beside a SET NOT NULL on the same table", () => {
    const sql = `UPDATE "document_links" SET "org_id" = 'o1' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "document_links" ALTER COLUMN "org_id" SET NOT NULL;`;
    expect(flags(sql)).toBe(false);
  });

  it("allows an UPDATE beside a CHECK on the same table", () => {
    const sql = `UPDATE "webhooks" SET "payload_mode" = 'full' WHERE "payload_mode" IS NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_payload_mode_valid" CHECK (payload_mode IN ('full', 'summary'));`;
    expect(flags(sql)).toBe(false);
  });

  it("allows an UPDATE beside a VALIDATE CONSTRAINT on the same table", () => {
    // Nothing in this file ADDs the constraint, and that is the point: §2
    // licences the repair beside the `VALIDATE`, not beside the `ADD`. The safe
    // pattern on a large table splits the two across releases — `0020` adds the
    // FK `NOT VALID`, `0021` repairs and validates — so demanding both in one
    // file would reject the shape the docs recommend. This IS `0021`'s shape.
    const sql = `UPDATE llm_usage SET run_id = NULL WHERE run_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" VALIDATE CONSTRAINT "llm_usage_run_id_org_id_fk";`;
    expect(flags(sql)).toBe(false);
  });

  it("does NOT licence a repair whose VALIDATE lives in another file", () => {
    // The other half of the split: `0020` on its own. Adding the constraint
    // `NOT VALID` validates no existing row, so no backfill is its
    // precondition — the repair belongs in the file that validates it.
    const sql = `ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_org_id_fk"
  FOREIGN KEY ("run_id","org_id") REFERENCES "public"."runs"("id","org_id") NOT VALID;--> statement-breakpoint
UPDATE llm_usage SET run_id = NULL WHERE run_id IS NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("allows a fold beside a DROP COLUMN on the same table", () => {
    // `0018`'s shape: after the DROP the source values no longer exist, so the
    // write cannot be deferred to `scripts/migration/`.
    const sql = `UPDATE "runs" SET "version_ref" = COALESCE("version_label", 'draft');--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "version_dirty";`;
    expect(flags(sql)).toBe(false);
  });

  it("does NOT licence a fold whose source column survives the file", () => {
    // `0033`'s second UPDATE: it strips a key out of a `metadata` column the
    // migration keeps. Nothing is destroyed, so nothing is inseparable — this
    // is ordinary data repair and belongs in `scripts/migration/`.
    const sql = `ALTER TABLE "runs" ADD COLUMN "chat_session_id" text;--> statement-breakpoint
UPDATE "runs" SET "metadata" = "metadata" - 'chatSessionId' WHERE "metadata" ? 'chatSessionId';`;
    expect(flags(sql)).toBe(true);
  });

  it("does NOT let a constraint on one table licence a rewrite of another", () => {
    // The bypass a future author reaches by accident: constrain table A, fold
    // rows on table B, gate green. This is `0018` minus the `DROP COLUMN` that
    // legitimately licences its `runs` rewrite.
    const sql = `UPDATE "runs" SET "version_ref" = 'draft';--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "one_actor" CHECK ((user_id IS NOT NULL) <> (end_user_id IS NOT NULL));`;
    expect(flags(sql)).toBe(true);
  });

  it("does NOT let a DROP COLUMN on one table licence a rewrite of another", () => {
    // Same tightness for the fold clause: `0040` drops `package_schedules`
    // columns and also wraps `application_packages` rows, and the second write
    // stays a finding.
    const sql = `UPDATE "application_packages" SET "input_settings" = jsonb_build_object('values', "input_settings");--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN IF EXISTS "config_override";`;
    expect(flags(sql)).toBe(true);
  });

  it("flags only the unlicenced statement when a file holds both", () => {
    const sql = `UPDATE "webhooks" SET "payload_mode" = 'full' WHERE "payload_mode" IS NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "k" CHECK (payload_mode IN ('full'));--> statement-breakpoint
DELETE FROM "runs" WHERE "status" = 'pending';`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toBe(`DELETE FROM "runs" WHERE "status" = 'pending';`);
  });

  it("does NOT treat a column-definition NOT NULL as a promotion", () => {
    // `ADD COLUMN … NOT NULL` on a populated table needs a DEFAULT, and that
    // default already satisfies the constraint — no backfill was ever its
    // precondition. §2 licences the PROMOTION (`SET NOT NULL`), not this.
    const sql = `ALTER TABLE "runs" ADD COLUMN "version_ref" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
UPDATE "runs" SET "version_ref" = 'other';`;
    expect(flags(sql)).toBe(true);
  });

  it("does NOT treat `IS NOT NULL` in a WHERE clause as adding a constraint", () => {
    const sql = `DELETE FROM "application_packages" WHERE "application_id" IS NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("matches tables across quoting, casing and schema qualification", () => {
    const sql = `UPDATE ONLY "public"."Runs" SET "c" = 1;--> statement-breakpoint
ALTER TABLE IF EXISTS public.runs ALTER COLUMN "c" SET NOT NULL;`;
    expect(flags(sql)).toBe(false);
  });

  it("fails closed when the DML target cannot be read", () => {
    const sql = `UPDATE 42 SET "c" = 1;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "c" SET NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });
});

describe("licencedTables", () => {
  it("attributes each clause to its own ALTER TABLE", () => {
    const sql = `ALTER TABLE "a" ALTER COLUMN "c" SET NOT NULL;
ALTER TABLE "b" ADD CONSTRAINT "k" CHECK (c > 0);
ALTER TABLE "c" VALIDATE CONSTRAINT "k";
ALTER TABLE "d" DROP COLUMN IF EXISTS "c";`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("does not read `DROP CONSTRAINT` as `DROP COLUMN`", () => {
    // `0018` opens with one, and it destroys no values — it licences nothing.
    const sql = `ALTER TABLE "package_schedules" DROP CONSTRAINT "at_most_one_actor";`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set());
  });

  it("attributes a clause nested in a DO block to the enclosing ALTER TABLE", () => {
    const sql = `DO $$
BEGIN
  ALTER TABLE "package_schedules" ALTER COLUMN "timezone" SET NOT NULL;
END $$;`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set(["package_schedules"]));
  });

  it("licences nothing for a file that only defines columns", () => {
    const sql = `ALTER TABLE "runs" ADD COLUMN "c" text DEFAULT 'x' NOT NULL;`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set());
  });
});

describe("findDml — CTE-led statements", () => {
  // `WITH … AS (DELETE … RETURNING *) INSERT INTO other …` is THE idiomatic
  // Postgres way to move rows between tables, and it passed this gate in
  // silence until `(` and `)` became boundaries.
  it("flags an UPDATE that follows a closing CTE paren", () => {
    const sql = `WITH stale AS (
  SELECT id FROM runs WHERE version_ref = 'draft'
)
UPDATE runs SET version_ref = 'v1' WHERE id IN (SELECT id FROM stale);`;
    expect(flags(sql)).toBe(true);
  });

  it("flags a DELETE inside a CTE body and the INSERT it feeds", () => {
    const sql = `WITH moved AS (
  DELETE FROM uploads WHERE size = 0 RETURNING *
)
INSERT INTO files SELECT * FROM moved;`;
    const findings = findDml(sql);
    expect(findings.map((f) => f.line)).toEqual([2, 4]);
  });

  it("flags a DML in the second body of a multi-CTE statement", () => {
    const sql = `WITH a AS (SELECT 1), b AS (DELETE FROM uploads RETURNING *)
SELECT * FROM b;`;
    expect(flags(sql)).toBe(true);
  });

  it("still ignores `ON DELETE` / `ON UPDATE` after a closing paren", () => {
    // The FK clause is the shape `)` had to be admitted without breaking:
    // `REFERENCES "orgs"("id") ON DELETE cascade` puts a `)` a few tokens
    // before the keyword, but `ON` is what directly precedes it.
    const sql = `ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_fk" FOREIGN KEY ("org_id")
  REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;`;
    expect(flags(sql)).toBe(false);
  });

  it("does not double-count `DO UPDATE SET` in an ON CONFLICT clause", () => {
    // The enclosing INSERT is already a finding on its own keyword; the
    // `UPDATE` in the conflict action must not add a second one.
    const sql = `INSERT INTO "orgs" ("id") VALUES ('o1')
  ON CONFLICT ("id") DO UPDATE SET "id" = excluded."id";`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toStartWith(`INSERT INTO "orgs"`);
  });

  it("does not treat a privilege list as two statements", () => {
    // `,` is deliberately not a boundary: `GRANT INSERT, UPDATE` grants a
    // right, it does not write a row.
    expect(flags(`GRANT INSERT, UPDATE ON "runs" TO "appstrate";`)).toBe(false);
  });
});

describe("findDml — TRUNCATE", () => {
  it("flags a bare TRUNCATE", () => {
    expect(flags(`TRUNCATE TABLE "runs";`)).toBe(true);
    expect(flags(`TRUNCATE "runs";`)).toBe(true);
    expect(flags(`TRUNCATE ONLY "runs" RESTART IDENTITY CASCADE;`)).toBe(true);
  });

  it("flags a TRUNCATE even when the same table gains a constraint", () => {
    // Emptying a table satisfies every constraint vacuously. Licencing that
    // would let "drop all rows, then promote the column" through the gate.
    const sql = `TRUNCATE TABLE "runs";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "version_ref" SET NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("flags every table of a comma-separated TRUNCATE through one finding", () => {
    const findings = findDml(`TRUNCATE "runs", "uploads", "files";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toBe(`TRUNCATE "runs", "uploads", "files";`);
  });

  it("ignores TRUNCATE inside a comment or a literal", () => {
    expect(
      flags(`-- we used to TRUNCATE "runs" here\nALTER TABLE "runs" ADD COLUMN "c" text;`),
    ).toBe(false);
  });
});

describe("findDml — writes deliberately outside the vocabulary", () => {
  // Documented on `licencedTables`: excluded on purpose, not overlooked. These
  // cases pin the decision so a future change to it is visible in the diff.
  it("does not flag `SELECT … INTO`", () => {
    expect(flags(`SELECT * INTO runs_backup FROM runs;`)).toBe(false);
  });

  it("does not flag a PL/pgSQL `SELECT … INTO` variable assignment", () => {
    const sql = `DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "runs";
END $$;`;
    expect(flags(sql)).toBe(false);
  });

  it("does not flag `COPY … FROM`", () => {
    expect(flags(`COPY runs (id) FROM '/tmp/x.csv';`)).toBe(false);
  });
});

describe("findDml — what is not a statement", () => {
  it("ignores DML keywords in a `--` comment", () => {
    const sql = `-- This migration used to UPDATE every row, and an INSERT was
-- considered. We DELETE nothing now.
ALTER TABLE "runs" ADD COLUMN "note" text;`;
    expect(flags(sql)).toBe(false);
  });

  it("ignores DML keywords in a block comment and in a string literal", () => {
    const sql = `/* DELETE FROM "runs" was the old plan */
ALTER TABLE "runs" ALTER COLUMN "note" SET DEFAULT 'INSERT INTO nothing';`;
    expect(flags(sql)).toBe(false);
  });

  it("ignores `ON DELETE` / `ON UPDATE` foreign-key actions", () => {
    const sql = `ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_fk" FOREIGN KEY ("org_id")
  REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;`;
    expect(flags(sql)).toBe(false);
  });

  it("ignores identifiers that merely start with a keyword", () => {
    const sql = `CREATE INDEX "idx_runs_updated" ON "runs" USING btree ("updated_at", "inserted_by");`;
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
    expect(findings[0]?.statement).toBe(`UPDATE "runs" SET "version_ref" = 'draft';`);
  });
});

describe("review", () => {
  const grandfathered = GRANDFATHERED[0]!;
  const offending = `UPDATE "runs" SET "version_ref" = 'draft';`;
  const present = new Map(GRANDFATHERED.map((name) => [name, offending]));

  it("passes a grandfathered file that rewrites rows", () => {
    expect(review(present)).toEqual([]);
  });

  it("fails the identical content under any other name", () => {
    // Same bytes, different filename — the exemption is a list of files, not a
    // property of the SQL.
    const problems = review(new Map([...present, ["9999_new_migration", offending]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("9999_new_migration.sql rewrites row contents");
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
    expect(problems[0]).toContain("not in packages/db/drizzle/");
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
