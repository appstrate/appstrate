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

/**
 * The `EXECUTE format(…)` sites that actually live in `packages/db/drizzle/`,
 * one fixture per distinct shape.
 *
 * These are the regression control for the dynamic-SQL pass. `EXECUTE
 * format(…)` is how this directory writes catalog-guarded DDL — 23 occurrences
 * across `0043`, `0047`, `0048` and `0053` when the pass was added, every one
 * of them a `RENAME`, a `DROP CONSTRAINT` or a probe — so a pass that reads
 * command strings as code has to read all of them as clean. Copied here rather
 * than scanned out of the directory for the reason this file's header gives:
 * a fixture keeps saying what it was written to say after the directory moves
 * on.
 */
const LIVE_DYNAMIC_DDL: readonly string[] = [
  // `0043` — the constraint rename, in both its fixed-table and `%s` forms.
  `EXECUTE format(
      'ALTER TABLE "public"."organizations" RENAME CONSTRAINT %I TO %I',
      r.conname, replace(r.conname, 'documents_bytes', 'files_bytes')
    );`,
  `EXECUTE format(
      'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
      r.tbl, r.conname, replace(r.conname, 'document', 'file')
    );`,
  // `0043` / `0053` — the index and sequence renames.
  `EXECUTE format(
      'ALTER INDEX %I.%I RENAME TO %I',
      r.schemaname, r.idxname, replace(r.idxname, 'document', 'file')
    );`,
  `EXECUTE format(
      'ALTER SEQUENCE %I.%I RENAME TO %I',
      r.schemaname, r.seqname, replace(r.seqname, 'application', 'space')
    );`,
  // `0053` — the column rename.
  `EXECUTE format(
      'ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
      'public', r.table_name, r.column_name,
      replace(r.column_name, 'application', 'space')
    );`,
  // `0047` — a probe, whose result feeds a PL/pgSQL variable.
  `EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', candidate) INTO has_rows;`,
  // `0048` — a `DROP CONSTRAINT` whose replacement, on the NEXT line, carries
  // `ON DELETE set null`. The discriminating one: the span must end at the
  // `EXECUTE`'s own `;`, or that FK action reads as a write.
  `EXECUTE format('ALTER TABLE public.organizations DROP CONSTRAINT %I', existing);
  END LOOP;
  ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."user"("id")
    ON DELETE set null ON UPDATE no action;`,
];

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
    //
    // Both arms, because the FK one is vacuous by itself: `FOREIGN KEY …` is no
    // `LICENCE` clause at all, so that file is reported whether or not
    // `NOT VALID` means anything here. The `CHECK` arm is the one that pins the
    // rule — `CHECK (` IS a licence clause, and it is the only one that names a
    // constraint's BIRTH rather than its enforcement, so only the trailing
    // `NOT VALID` keeps it from licencing the repair sitting beside it.
    const fk = `ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_org_id_fk"
  FOREIGN KEY ("run_id","org_id") REFERENCES "public"."runs"("id","org_id") NOT VALID;--> statement-breakpoint
UPDATE llm_usage SET run_id = NULL WHERE run_id IS NOT NULL;`;
    const check = `ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_one_owner"
  CHECK (run_id IS NULL OR chat_session_id IS NULL) NOT VALID;--> statement-breakpoint
UPDATE llm_usage SET run_id = NULL WHERE chat_session_id IS NOT NULL;`;
    expect(flags(fk)).toBe(true);
    expect(flags(check)).toBe(true);
  });

  it("reads `NOT VALID` from the CHECK's own ACTION, not from the rest of its statement", () => {
    // The other direction, so the rule above cannot over-reach: a `NOT VALID`
    // on an unrelated constraint must not retroactively disarm a CHECK that
    // really is enforced. Were the search not bounded, following §2's advice
    // anywhere in a file would strip the licence from every CHECK in it.
    //
    // `ALTER TABLE` takes a COMMA-SEPARATED action list, so both constraints
    // below live inside ONE `;` — which is what makes this fixture bite. The
    // `;`-separated variant (the two constraints split by an intervening
    // `--> statement-breakpoint`) is the strictly weaker case: there the
    // statement boundary already separates them, so it passes under a
    // statement-wide scan too and proves nothing about the bound.
    const sql = `ALTER TABLE "llm_usage"
  ADD CONSTRAINT "llm_usage_one_owner" CHECK (run_id IS NULL OR chat_session_id IS NULL),
  ADD CONSTRAINT "llm_usage_run_id_org_id_fk" FOREIGN KEY ("run_id","org_id")
    REFERENCES "public"."runs"("id","org_id") NOT VALID;--> statement-breakpoint
UPDATE llm_usage SET run_id = NULL WHERE chat_session_id IS NOT NULL;`;
    expect(flags(sql)).toBe(false);
  });

  it("licences the same repair when the action list carries no `NOT VALID` at all", () => {
    // The control for the case above: the identical file minus the deferred FK.
    // Without it the pass above could be a detector that licences everything.
    const sql = `ALTER TABLE "llm_usage"
  ADD CONSTRAINT "llm_usage_one_owner" CHECK (run_id IS NULL OR chat_session_id IS NULL);--> statement-breakpoint
UPDATE llm_usage SET run_id = NULL WHERE chat_session_id IS NOT NULL;`;
    expect(flags(sql)).toBe(false);
  });

  it("still reads a `NOT VALID` that sits on the CHECK's own action in an action list", () => {
    // The half that keeps the bound honest: narrowing the search to one action
    // must not narrow it past the trailing `NOT VALID` belonging to THAT
    // action. Same file as the pair above, with the `NOT VALID` moved onto the
    // CHECK — nothing is enforced, so nothing is licenced.
    const sql = `ALTER TABLE "llm_usage"
  ADD CONSTRAINT "llm_usage_one_owner" CHECK (run_id IS NULL OR chat_session_id IS NULL) NOT VALID,
  ADD CONSTRAINT "llm_usage_run_id_org_id_fk" FOREIGN KEY ("run_id","org_id")
    REFERENCES "public"."runs"("id","org_id");--> statement-breakpoint
UPDATE llm_usage SET run_id = NULL WHERE chat_session_id IS NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("finds a `NOT VALID` past a CHECK expression that itself contains a comma", () => {
    // The action's span is found by matching the CHECK's parentheses and then
    // reading to the next `,` at depth 0 — never by splitting on `,`. A comma
    // INSIDE the expression ends the span early under a naive split, and the
    // trailing `NOT VALID` goes unseen. (The literals here are blanked by
    // `sanitize`, but the comma between them is not: it is real syntax.)
    const sql = `ALTER TABLE "webhooks"
  ADD CONSTRAINT "webhooks_payload_mode_valid" CHECK (payload_mode IN ('full', 'summary')) NOT VALID;--> statement-breakpoint
UPDATE "webhooks" SET "payload_mode" = 'full' WHERE "payload_mode" IS NULL;`;
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

  it("does NOT treat a column-definition CHECK as a constraint promotion", () => {
    // The `NOT NULL` argument above, verbatim, for the other clause that can
    // appear in a column DEFINITION: `ADD COLUMN … CHECK (…)` gives a
    // BRAND-NEW column its constraint, so every existing row satisfies it
    // vacuously and no backfill was ever its precondition. Only
    // `ADD CONSTRAINT <name> CHECK (…)` licences — and that is not decoration:
    // a bare `CHECK (` made the `NOT VALID` rule above bypassable, by moving
    // the constraint inline where no `NOT VALID` can be written.
    const sql = `ALTER TABLE "runs" ADD COLUMN "attempts" integer CHECK ("attempts" >= 0);--> statement-breakpoint
UPDATE "runs" SET "attempts" = 0;`;
    expect(flags(sql)).toBe(true);
  });

  it("does NOT treat a CHECK inside a CREATE TABLE as a constraint promotion", () => {
    // The same class of non-event, at its most obvious: the table is being
    // created, so it holds no row the CHECK could require a repair for.
    const sql = `CREATE TABLE "quotas" (
  "id" text PRIMARY KEY NOT NULL,
  "seats" integer CHECK ("seats" > 0)
);--> statement-breakpoint
UPDATE "quotas" SET "seats" = 1;`;
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

  it("does NOT licence a repair from a clause that only appears in a comment or a literal", () => {
    // The licence direction of `sanitize` — the DML direction is covered under
    // "what is not a statement". A `SET NOT NULL` written in prose, or parked
    // inside a string, promotes no column, so it must not excuse the write
    // beside it. Both fixtures put the text exactly where an enclosing
    // `ALTER TABLE` would attribute it to the very table being rewritten, which
    // is what makes them discriminating: stop blanking and both pass.
    const inComment = `ALTER TABLE "runs" ADD COLUMN "version_ref" text;--> statement-breakpoint
-- next release: ALTER TABLE "runs" ALTER COLUMN "version_ref" SET NOT NULL;
UPDATE "runs" SET "version_ref" = 'draft';`;
    const inLiteral = `ALTER TABLE "runs" ALTER COLUMN "note" SET DEFAULT 'then ALTER COLUMN version_ref SET NOT NULL';--> statement-breakpoint
UPDATE "runs" SET "version_ref" = 'draft';`;
    expect(flags(inComment)).toBe(true);
    expect(flags(inLiteral)).toBe(true);
  });
});

describe("findDml — only an UPDATE is licenceable", () => {
  // Both shapes §2 exempts are `UPDATE`s: a backfill fills the column a
  // constraint is about to require, and a fold copies a column's values
  // somewhere else before the file drops it. Neither is expressible as an
  // `INSERT` or a `DELETE`, so no licence clause may excuse one. Licencing is
  // closed by default and opened for that one verb — a blacklist that refused
  // only `TRUNCATE` opened it for every other verb, and `DELETE FROM "t";`
  // empties a table exactly as `TRUNCATE "t";` does.
  it("still reports a DELETE beside a DROP COLUMN on the same table", () => {
    const sql = `DELETE FROM "runs" WHERE "version_label" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "version_label";`;
    expect(flags(sql)).toBe(true);
  });

  it("still reports a DELETE beside a SET NOT NULL on the same table", () => {
    // The destructive way to satisfy a promotion: delete the rows that would
    // violate it, rather than repair them. That is the destruction this gate
    // exists to stop, and it is the same statement `TRUNCATE` was refused for.
    const sql = `DELETE FROM "runs" WHERE "version_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "version_ref" SET NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("still reports an INSERT beside a CHECK on the same table", () => {
    const sql = `INSERT INTO "webhooks" ("id", "payload_mode") VALUES ('w1', 'full');--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_payload_mode_valid" CHECK (payload_mode IN ('full', 'summary'));`;
    expect(flags(sql)).toBe(true);
  });

  it("still reports an INSERT beside a VALIDATE CONSTRAINT on the same table", () => {
    const sql = `INSERT INTO "llm_usage" ("id") VALUES ('u1');--> statement-breakpoint
ALTER TABLE "llm_usage" VALIDATE CONSTRAINT "llm_usage_run_id_org_id_fk";`;
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

  it("licences nothing from a clause inside a CREATE FUNCTION body", () => {
    // The same carve-out as the write scan, in the other direction, and the
    // pair has to move together: exempting a body from the write scan alone
    // would turn a function definition into a way to MANUFACTURE a licence for
    // a write elsewhere in the file. Nothing in a body promotes a column when
    // the migration is applied.
    const sql = `CREATE FUNCTION f() RETURNS void AS $$
BEGIN
  ALTER TABLE "runs" ALTER COLUMN "c" SET NOT NULL;
END;
$$ LANGUAGE plpgsql;`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set());
    expect(flags(`${sql}--> statement-breakpoint\nUPDATE "runs" SET "c" = 1;`)).toBe(true);
  });

  it("still licences from a clause inside a DO block", () => {
    // The control for the case above, and the shape `0051` is written in: a
    // `DO` block runs at apply time, so a promotion inside one is a real
    // promotion.
    const sql = `DO $$
BEGIN
  ALTER TABLE "runs" ALTER COLUMN "c" SET NOT NULL;
END $$;`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set(["runs"]));
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

describe("findDml — MERGE", () => {
  // PostgreSQL 16 writes rows in all three directions with a single MERGE. It
  // used to be caught only by ACCIDENT, through the `UPDATE` behind its
  // `WHEN MATCHED THEN` — which `dmlTarget` then read as a write to a table
  // called `set`, producing a finding no author could act on.
  it("flags a MERGE, and reports the whole statement exactly once", () => {
    const sql = `MERGE INTO "runs" t USING "staging" s ON t."id" = s."id"
WHEN MATCHED THEN UPDATE SET "status" = s."status"
WHEN NOT MATCHED THEN INSERT ("id") VALUES (s."id");`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.statement).toStartWith(`MERGE INTO "runs"`);
  });

  it("does not report a MERGE's WHEN actions as statements of their own", () => {
    // `THEN` is a STATEMENT_OPENER and has to stay one, for the PL/pgSQL
    // `IF … THEN INSERT …` it was added for. So without the merge-statement
    // skip each action here is a second finding quoting a fragment.
    const sql = `MERGE INTO "runs" t USING "staging" s ON t."id" = s."id"
WHEN MATCHED AND s."stale" THEN DELETE
WHEN MATCHED THEN UPDATE SET "status" = 'done'
WHEN NOT MATCHED THEN INSERT ("id") VALUES (s."id");`;
    expect(findDml(sql)).toHaveLength(1);
  });

  it("resumes reporting after the MERGE's own statement ends", () => {
    // The skip is bounded by the MERGE's `;`. An unrelated write on the next
    // line must not ride through on it.
    const sql = `MERGE INTO "runs" t USING "staging" s ON t."id" = s."id"
  WHEN MATCHED THEN UPDATE SET "status" = 'done';--> statement-breakpoint
DELETE FROM "uploads";`;
    expect(findDml(sql).map((f) => f.line)).toEqual([1, 3]);
  });

  it("never licences a MERGE, whatever clause the file carries on that table", () => {
    // §2 opens licencing for one verb, `UPDATE`, and a MERGE can delete rows
    // (`WHEN MATCHED THEN DELETE` is a legal action). Licencing it would
    // re-open exactly what refusing `DELETE` and `TRUNCATE` beside a
    // constraint is for. Both licence shapes, so neither is the exception.
    const notNull = `MERGE INTO "runs" t USING "s" s ON t."id" = s."id" WHEN MATCHED THEN UPDATE SET "c" = 1;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "c" SET NOT NULL;`;
    const dropColumn = `MERGE INTO "runs" t USING "s" s ON t."id" = s."id" WHEN MATCHED THEN UPDATE SET "c" = 1;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "old";`;
    expect(flags(notNull)).toBe(true);
    expect(flags(dropColumn)).toBe(true);
  });

  it("does not report a dynamic MERGE's WHEN actions as statements of their own", () => {
    // The same fold as above, in the second pass. Here the duplicates are
    // worse: all three findings quote the identical `EXECUTE format(…)`, so the
    // author is shown one line three times over.
    const sql = `DO $$ BEGIN EXECUTE format('MERGE INTO t USING s ON t.id = s.id
  WHEN MATCHED THEN UPDATE SET x = 1
  WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)'); END $$;`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toStartWith(`EXECUTE format('MERGE INTO t`);
  });

  it("resumes reporting after a dynamic MERGE's own statement ends", () => {
    // The bound, as in the literal pass: the skip stops at the MERGE's `;`, so
    // a second command built on the next line is still its own finding.
    const sql = `DO $$ BEGIN
  EXECUTE format('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1');
  EXECUTE format('DELETE FROM u');
END $$;`;
    expect(findDml(sql).map((f) => f.line)).toEqual([2, 3]);
  });

  it("ignores `MERGE` in a comment and in an identifier that starts with it", () => {
    expect(
      flags(`-- we could MERGE the two tables here\nALTER TABLE "runs" ADD COLUMN "c" text;`),
    ).toBe(false);
    expect(flags(`CREATE INDEX "idx_runs_merged" ON "runs" USING btree ("merged_at");`)).toBe(
      false,
    );
  });
});

describe("findDml — a DO body is code however it is quoted", () => {
  // `DO [LANGUAGE lang] code` takes a STRING CONSTANT, and `$$ … $$` is only
  // one way to spell one. `DO '…'` is the same statement and mutates the same
  // rows on every replay — but was invisible, because `sanitize` blanked its
  // body with every other literal and no dynamic span ever opened on `DO`.
  it("flags every statement in a single-quoted DO body", () => {
    const findings = findDml(`DO 'BEGIN UPDATE t SET x = 99; DELETE FROM t WHERE id = 2; END';`);
    expect(findings.map((f) => f.statement)).toEqual([
      `UPDATE t SET x = 99;`,
      `DELETE FROM t WHERE id = 2;`,
    ]);
  });

  it("flags a single-quoted DO body with LANGUAGE written before or after it", () => {
    // Postgres accepts the two items in either order, so neither position may
    // be the one that hides the body.
    expect(flags(`DO LANGUAGE plpgsql 'BEGIN DELETE FROM "runs"; END';`)).toBe(true);
    expect(flags(`DO 'BEGIN DELETE FROM "runs"; END' LANGUAGE plpgsql;`)).toBe(true);
  });

  it("licences a single-quoted DO body exactly as it licences a `$$` one", () => {
    // Why the body is read in pass 1 rather than as a dynamic span: pass 2
    // applies no carve-out, so `0051`'s shape written with the other quote
    // would become an unconditional finding. Both spellings, so neither is the
    // exception.
    const body = `BEGIN UPDATE "runs" SET "c" = 1; END`;
    const promote = `ALTER TABLE "runs" ALTER COLUMN "c" SET NOT NULL;`;
    expect(flags(`DO '${body}';--> statement-breakpoint\n${promote}`)).toBe(false);
    expect(flags(`DO $$ ${body} $$;--> statement-breakpoint\n${promote}`)).toBe(false);
  });

  it("reads a licence clause out of a single-quoted DO body", () => {
    // The other direction of the same symmetry — the `$$` case is covered under
    // `licencedTables`. A promotion written in a `DO '…'` runs at apply time,
    // so it is a real promotion.
    const sql = `DO 'BEGIN ALTER TABLE "runs" ALTER COLUMN "c" SET NOT NULL; END';`;
    expect(licencedTables(sanitize(sql))).toEqual(new Set(["runs"]));
  });

  it("does NOT read an ordinary literal as code because a `DO` appears nearby", () => {
    // The control, and the shape it has to survive: `ON CONFLICT DO UPDATE`
    // puts that word directly in front of a statement's own clauses. The
    // enclosing INSERT is the one finding; the `'DELETE FROM runs'` parked in
    // the conflict action is a VALUE and must stay blanked.
    const sql = `INSERT INTO "orgs" ("id") VALUES ('o1')
  ON CONFLICT ("id") DO UPDATE SET "note" = 'DELETE FROM runs';`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toStartWith(`INSERT INTO "orgs"`);
  });
});

describe("findDml — an E'…' escape string does not desynchronise the scanner", () => {
  // `sanitize` walks a literal to find its terminating quote. Only `E'…'`
  // processes backslashes, and missing that ends the literal at the wrong quote
  // — which inverts every blanking decision in the REST of the file, and does
  // it silently: the gate then reports nothing at all.
  it("still flags the statement after an E-string containing an escaped quote", () => {
    const sql = `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT E'don\\'t';--> statement-breakpoint
DELETE FROM "t";`;
    expect(flags(sql)).toBe(true);
  });

  it("does not read a backslash in an ordinary literal as an escape", () => {
    // The control, and why the rule cannot be unconditional: a standard string
    // does NOT process backslashes, so `'\'` is a one-character value that ends
    // at its second quote — and `'\s+'` is real, in `0046`. Reading either as
    // an escape swallows the terminator, and the rest of the file with it.
    for (const value of [String.raw`'\'`, String.raw`'\s+'`]) {
      const sql = `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT ${value};--> statement-breakpoint
DELETE FROM "t";`;
      expect(flags(sql)).toBe(true);
    }
  });
});

describe("findDml — dynamic SQL built by EXECUTE / format(…)", () => {
  // THE reachable bypass, before this pass existed. `sanitize` blanks
  // single-quoted literals — right for prose and for `'DELETE'`-as-a-value,
  // and wrong for the one literal the server executes.
  it("flags a write built by `EXECUTE format(…)`", () => {
    const sql = `DO $$ BEGIN EXECUTE format('UPDATE t SET x = 1'); END $$;`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    // Quoted from the `EXECUTE`, not from inside the literal: the statement an
    // author has to go and fix is the one that builds the command.
    expect(findings[0]?.statement).toBe(`EXECUTE format('UPDATE t SET x = 1');`);
  });

  it("flags a write handed straight to `EXECUTE` as a literal", () => {
    expect(flags(`DO $$ BEGIN EXECUTE 'DELETE FROM t'; END $$;`)).toBe(true);
  });

  it("flags a command assembled into a variable and executed later", () => {
    // The same bypass in two statements. `format(` is a span in its own right
    // and not only one nested inside an `EXECUTE`, so this is seen too.
    const sql = `DO $$
DECLARE stmt text;
BEGIN
  stmt := format('TRUNCATE %I', 'runs');
  EXECUTE stmt;
END $$;`;
    expect(flags(sql)).toBe(true);
  });

  it("reports a dynamic write no matter what the file constrains", () => {
    // No carve-out applies: the target is a `%I` filled from a catalog query,
    // so there is no table name a licence could be matched against, and the
    // gate fails closed exactly as it does for an unreadable target.
    const sql = `DO $$ BEGIN EXECUTE format('UPDATE %I SET c = 1', 'runs'); END $$;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "c" SET NOT NULL;`;
    expect(flags(sql)).toBe(true);
  });

  it("leaves every live `EXECUTE format(…)` DDL shape clean", () => {
    // The regression control. Every one of these is in the directory today
    // (see `LIVE_DYNAMIC_DDL`); a pass that reads command strings as code and
    // flags one of them would be unusable.
    for (const fixture of LIVE_DYNAMIC_DDL) {
      expect(findDml(`DO $$\nDECLARE r record;\nBEGIN\n  ${fixture}\nEND $$;`)).toEqual([]);
    }
  });

  it("does not read a dynamic FK's `ON DELETE` action as a write", () => {
    // The narrower half of the control above: a command string is scanned with
    // the same statement-opener discipline as the rest of the file, so
    // `ON DELETE CASCADE` inside one is still a clause, not a statement.
    const sql = `DO $$ BEGIN
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT k FOREIGN KEY (a) REFERENCES b(c) ON DELETE CASCADE', t);
END $$;`;
    expect(flags(sql)).toBe(false);
  });

  it("does not read a `CREATE TRIGGER … EXECUTE FUNCTION` clause as dynamic SQL", () => {
    // `EXECUTE FUNCTION` names a function; it hands the server no command
    // string, so it opens no span.
    const sql = `CREATE TRIGGER "runs_notify" AFTER INSERT ON "runs"
  FOR EACH ROW EXECUTE FUNCTION notify_run_change();`;
    expect(flags(sql)).toBe(false);
  });

  it("still blanks a literal that no EXECUTE or format(…) reaches", () => {
    // The other direction, and the reason literals are blanked at all: a DML
    // keyword parked in an ordinary value is not a statement. Only a command
    // string is read as code, so this must stay clean.
    const sql = `ALTER TABLE "runs" ALTER COLUMN "note" SET DEFAULT 'DELETE FROM runs';--> statement-breakpoint
DO $$ BEGIN EXECUTE format('ALTER TABLE %I RENAME TO %I', 'a', 'b'); END $$;`;
    expect(flags(sql)).toBe(false);
  });
});

describe("findDml — a CREATE FUNCTION body is a definition, not a write", () => {
  // Defining a trigger function writes a `pg_proc` row, which is schema. Its
  // `INSERT` runs later, per row, when something touches the table the trigger
  // is on — the application's behaviour, not a one-off repair.
  it("does not flag DML inside a CREATE FUNCTION body", () => {
    const sql = `CREATE FUNCTION f() RETURNS trigger AS $$
BEGIN
  INSERT INTO "audit" ("kind") VALUES ('run');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;
    expect(flags(sql)).toBe(false);
  });

  it("does not flag DML inside a CREATE OR REPLACE PROCEDURE body either", () => {
    const sql = `CREATE OR REPLACE PROCEDURE p() LANGUAGE plpgsql AS $body$
BEGIN
  DELETE FROM "runs" WHERE "status" = 'pending';
END;
$body$;`;
    expect(flags(sql)).toBe(false);
  });

  it("STILL flags DML inside a DO block — the counter-case", () => {
    // A `DO $$ … $$` executes at apply time, against the rows that exist,
    // which is precisely what §2 forbids. `0021`, `0023`, `0040` and `0051`
    // are that shape, and the whole distinction is the `CREATE … FUNCTION` in
    // front of the dollar quote.
    expect(flags(`DO $$ BEGIN INSERT INTO "audit" ("kind") VALUES ('run'); END $$;`)).toBe(true);
  });

  it("flags only the DO block when a file carries both", () => {
    const sql = `CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $fn$
BEGIN
  INSERT INTO "audit" ("kind") VALUES ('run');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN DELETE FROM "runs"; END $$;`;
    const findings = findDml(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.statement).toStartWith(`DELETE FROM "runs"`);
  });

  it("does not flag DML inside a `BEGIN ATOMIC` body", () => {
    // PostgreSQL 14's standard `LANGUAGE sql` body, and the form a SQL-language
    // helper is written in today. It is a DEFINITION exactly as a dollar-quoted
    // one is — reporting it was a false positive whose only remedy was the
    // `EXECUTE format(…)` bypass this gate closes elsewhere.
    const sql = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC
  SELECT 1;
  INSERT INTO "audit" ("kind") VALUES ('run');
END;`;
    expect(flags(sql)).toBe(false);
  });

  it("finds the end of a `BEGIN ATOMIC` body past a `CASE … END` inside it", () => {
    // The body's end is found by COUNTING `CASE`/`END`, never by matching the
    // first `END`: an atomic body admits no nested block, but a `CASE` in one
    // of its expressions closes with the same word. Stopping at that one ends
    // the span early and the `INSERT` after it reads as an apply-time write.
    const sql = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC
  SELECT CASE WHEN true THEN 1 ELSE 2 END;
  INSERT INTO "audit" ("kind") VALUES ('run');
END;`;
    expect(flags(sql)).toBe(false);
  });

  it("STILL flags a DO block that follows a `BEGIN ATOMIC` body", () => {
    // The negative control for the span's other end: the exemption must stop at
    // the body's own `END`, or the rest of the file rides through on it.
    const sql = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC
  SELECT 1;
END;--> statement-breakpoint
DO $$ BEGIN DELETE FROM "runs"; END $$;`;
    expect(flags(sql)).toBe(true);
  });

  it("fails closed on an unterminated `BEGIN ATOMIC` body", () => {
    // No `END` closes it, so no span is produced and what is inside is
    // reported. A body span guessed from a malformed definition would be a way
    // to exempt the rest of the file.
    const sql = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC
  SELECT 1;
  INSERT INTO "audit" ("kind") VALUES ('run');`;
    expect(flags(sql)).toBe(true);
  });

  it("does not let a string-bodied CREATE FUNCTION swallow a later DO block", () => {
    // `AS 'SELECT 1'` opens no dollar quote, so the next `$$` in the file
    // belongs to something else — here, a DO block that must stay flagged.
    // The body span is bounded by the CREATE's own `;` for exactly this.
    const sql = `CREATE FUNCTION f() RETURNS integer AS 'SELECT 1' LANGUAGE sql;--> statement-breakpoint
DO $$ BEGIN DELETE FROM "runs"; END $$;`;
    expect(flags(sql)).toBe(true);
  });

  it("does not flag dynamic SQL a function body builds", () => {
    // Both carve-outs at once: the command string is read as code, and then
    // discarded because the body it sits in defines behaviour rather than
    // running it.
    const sql = `CREATE FUNCTION f() RETURNS trigger AS $$
BEGIN
  EXECUTE format('INSERT INTO %I VALUES (1)', TG_TABLE_NAME);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;
    expect(flags(sql)).toBe(false);
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
    // Every entry, not `GRANDFATHERED[0]`: the list's composition is itself
    // under review (an entry leaves when its file leaves the directory), so a
    // test that indexes into it pins whichever name happens to sort first and
    // stops covering the rest the moment that changes.
    for (const name of GRANDFATHERED) {
      const missing = new Map(present);
      missing.delete(name);
      const problems = review(missing);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(name);
      expect(problems[0]).toContain("not in packages/db/drizzle/");
    }
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

  it("ends an `E'…'` literal at its real terminator, not at an escaped quote", () => {
    // The offsets are the whole point: a literal that ends two quotes late
    // leaves the walker blanking code and keeping prose for the rest of the
    // file. `kept` on the far side is what proves it resynchronised.
    const sql = String.raw`SELECT E'don\'t', "kept";`;
    const out = sanitize(sql);
    expect(out).toHaveLength(sql.length);
    expect(out).toContain("kept");
    expect(out).not.toContain("don");
  });

  it("does not treat a backslash as an escape outside an `E'…'` string", () => {
    // `'\'` is a complete one-character value in a standard string. Reading its
    // backslash as an escape runs the literal on to the next quote.
    const sql = String.raw`SELECT '\', "kept";`;
    const out = sanitize(sql);
    expect(out).toHaveLength(sql.length);
    expect(out).toContain("kept");
  });

  it("reads a `DO '…'` body as code and an ordinary literal as prose", () => {
    // Both directions in one assertion, because the risk of the first is
    // exactly the second: a `'…'` that is a VALUE must not start being read as
    // code because the file also contains the word `DO`.
    const out = sanitize(`DO 'BEGIN DELETE FROM t; END';\nSELECT 'DELETE FROM t';`);
    expect(out).toContain("BEGIN DELETE FROM t; END");
    expect(out.split("\n")[1]).not.toContain("DELETE");
  });

  it("keeps the body and blanks the delimiters under `keepLiterals`", () => {
    // The second reading `findDml` needs. Byte offsets must survive it too:
    // a finding made in this copy is quoted through the blanked one.
    const sql = `EXECUTE format('UPDATE t SET x = 1');`;
    const out = sanitize(sql, { keepLiterals: true });
    expect(out).toHaveLength(sql.length);
    expect(out).toContain("UPDATE t SET x = 1");
    expect(out).not.toContain("'");
  });

  it("still blanks comments under `keepLiterals`", () => {
    // Prose is prose in both readings — the `EXECUTE format(…)` blocks this
    // directory comments out (`0048`, `0053`) must not come back as code.
    const out = sanitize(`-- EXECUTE format('UPDATE t SET x = 1')\nSELECT 1;`, {
      keepLiterals: true,
    });
    expect(out).not.toContain("UPDATE");
    expect(out).toContain("SELECT 1;");
  });

  it("keeps an empty literal and an escaped quote at the right width", () => {
    for (const sql of [`SELECT '';`, `SELECT 'it''s';`]) {
      expect(sanitize(sql, { keepLiterals: true })).toHaveLength(sql.length);
    }
  });
});
