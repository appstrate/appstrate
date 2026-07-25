-- Tenant integrity + FK-side indexes for the documents subsystem, and the money
-- floors on the spend ledger.
--
-- WHY: this platform has NO row-level security. Every cross-tenant guarantee is
-- either an application-level `WHERE org_id = …` or a database constraint, and
-- the database is the last line of defence for the cases the application misses.
-- Two are missed today:
--   * `documents` carries `org_id` AND a `run_id` / `chat_session_id` container,
--     with only single-column FKs proving the container EXISTS — never that it
--     belongs to the same org. Same defect CRIT-07 closed on `llm_usage`
--     (migrations 0020/0021), same fix: a composite FK through the container's
--     `(id, org_id)` unique index.
--   * `document_links` carries neither `org_id` nor any composite FK, yet it is
--     what decides detach-vs-delete: `deleteDocument` looks up links by
--     `document_id` alone, with NO org filter, and refuses the delete if any
--     link exists. One cross-tenant link row is therefore a permanent denial of
--     deletion against another org's document.
-- Both tables are EMPTY in production, which makes this the one window where
-- adding and validating these constraints costs nothing.
--
-- Also here:
--   * The missing referencing-side indexes for the cascading / SET NULL FKs on
--     `documents` and `uploads`. Postgres indexes the REFERENCED side of a
--     foreign key only; without these, deleting one application / end-user
--     seq-scans the whole child table under the cascade's lock.
--   * The `>= 0` floors on `llm_usage.cost_usd` and `runs.cost` (see the last
--     step).
--
-- Every statement is RE-RUNNABLE, same discipline as 0020/0021/0023–0028 (this
-- database has a history of hand-repaired migration state; the recovery is to
-- replay a migration).
--
-- Nothing here is added `NOT VALID`. Splitting `ADD CONSTRAINT … NOT VALID`
-- from a later `VALIDATE CONSTRAINT` only relieves lock pressure when the two
-- halves land in DIFFERENT deploys: the boot migrator applies every pending
-- migration inside ONE transaction, so the ACCESS EXCLUSIVE the `ADD CONSTRAINT`
-- takes is held until that transaction commits and the validation scan happens
-- under it either way. Production's watermark is 0022, so 0023–0029 all apply
-- together — the split would buy a second migration and zero lock relief.

-- Step 1: FK-side indexes on `uploads` (org cascade, end-user cascade,
-- created-by SET NULL). Partial where the column is nullable so the dominant
-- NULL population never enters the index.
CREATE INDEX IF NOT EXISTS "idx_uploads_org" ON "uploads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploads_end_user" ON "uploads" USING btree ("end_user_id") WHERE "uploads"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploads_created_by" ON "uploads" USING btree ("created_by") WHERE "uploads"."created_by" IS NOT NULL;--> statement-breakpoint

-- Step 2: FK-side indexes on `documents`. `application_id` is NOT covered by
-- `idx_documents_org_app_created` — it is not that index's leading column.
CREATE INDEX IF NOT EXISTS "idx_documents_end_user" ON "documents" USING btree ("end_user_id") WHERE "documents"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_application" ON "documents" USING btree ("application_id");--> statement-breakpoint

-- Step 3: referenced target of `document_links`' composite FK below. MUST come
-- before that FK — Postgres requires a unique index on the referenced column
-- pair. Trivially valid: `id` alone is the PK, so `(id, org_id)` can never
-- collide; this only pays an index build.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_documents_id_org_id" ON "documents" USING btree ("id","org_id");--> statement-breakpoint

-- Step 4: composite tenant-integrity FKs on `documents`. `documents` is created
-- five migrations earlier in this same undeployed batch, so the validation scan
-- these force is over an EMPTY table (same argument as 0026's single-container
-- CHECK). NULL container rows pass per MATCH SIMPLE. ON DELETE cascade
-- deliberately mirrors the single-column FKs already on these columns — the
-- service path detaches link-protected documents BEFORE deleting a run, and the
-- cascade is the fallback for the unprotected remainder.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_run_id_org_id_fk'
      AND conrelid = 'public.documents'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_run_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "public"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_chat_session_id_org_id_fk'
      AND conrelid = 'public.documents'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_chat_session_id_org_id_fk" FOREIGN KEY ("chat_session_id","org_id") REFERENCES "public"."chat_sessions"("id","org_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- Step 5: `document_links.org_id`. Added NULLABLE, backfilled from the parent
-- document, then promoted to NOT NULL — never `ADD COLUMN … NOT NULL` without a
-- default, which fails outright on any non-empty table. Each sub-step is
-- independently guarded so a partially-applied replay resumes correctly.
ALTER TABLE "document_links" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
UPDATE "document_links" l SET "org_id" = d."org_id" FROM "documents" d WHERE d."id" = l."document_id" AND l."org_id" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.document_links'::regclass
      AND attname = 'org_id'
      AND NOT attnotnull
  ) THEN
    ALTER TABLE "document_links" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $$;--> statement-breakpoint

-- Step 6: composite tenant-integrity FKs on `document_links` — the link's
-- document AND its consuming run must both belong to the org on the row, which
-- makes a cross-tenant link (and the denial-of-deletion it causes)
-- unrepresentable. `document_links` is created three migrations earlier in this
-- same undeployed batch, so validation is again over an empty table. The
-- referencing side of both is already covered: the composite PK leads with
-- `document_id`, `idx_document_links_consumer_run` leads with `consumer_run_id`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_links_document_id_org_id_fk'
      AND conrelid = 'public.document_links'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_org_id_fk" FOREIGN KEY ("document_id","org_id") REFERENCES "public"."documents"("id","org_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_links_consumer_run_id_org_id_fk'
      AND conrelid = 'public.document_links'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "document_links" ADD CONSTRAINT "document_links_consumer_run_id_org_id_fk" FOREIGN KEY ("consumer_run_id","org_id") REFERENCES "public"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- Step 7: money floor at the column, not only in the application.
--
-- `llm_usage.cost_usd` is the append-only spend ledger billing reads (the cloud
-- sweeper debits credits off it by serial-id cursor) and `runs.cost` is the
-- denormalized per-run cache of the same money. Both were clamped to >= 0 only
-- by their writers: one bad rate table, one sign slip in a provider's usage
-- payload, or one new write path that bypasses `recordLlmUsage`, and an org gets
-- CREDITED for spending — with no later pass able to notice, since the runner
-- upsert only ever advances a row monotonically upward from whatever it holds.
--
-- These two DO scan pre-existing rows, and that is intended: a negative row here
-- is a billing error that MUST surface at deploy time, not be worked around by
-- deferring the check. Neither can fail on current data — both columns have been
-- written exclusively through `recordLlmUsage` / the run finalizer, which clamp
-- at zero. NULL passes both (standard SQL CHECK semantics): `runs.cost` is NULL
-- until a run reports usage.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_cost_usd_non_negative'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_cost_usd_non_negative" CHECK (cost_usd >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_cost_non_negative'
      AND conrelid = 'public.runs'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "runs" ADD CONSTRAINT "runs_cost_non_negative" CHECK (cost >= 0);
  END IF;
END $$;
