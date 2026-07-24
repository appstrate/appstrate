-- Tenant integrity + FK-side indexes for the documents subsystem.
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
-- Also here (they touch the same tables and belong in one lock window):
--   * `uploads.size` int4 → int8. `documents.size` is already bigint and an
--     upload is materialized into a document, so the staging half of the
--     pipeline carried a ~2.1 GB ceiling the durable half does not.
--   * The missing referencing-side indexes for every cascading / SET NULL FK on
--     `documents` and `uploads`. Postgres indexes the REFERENCED side of a
--     foreign key only; without these, deleting one application / end-user /
--     user seq-scans the whole child table under the cascade's lock.
--   * A retention index on `storage_deletion_jobs`: the table keeps one row per
--     deleted object forever and both existing indexes are partial on
--     `completed_at IS NULL`, so a purge of completed rows has no index at all.
--
-- Every statement is RE-RUNNABLE, same discipline as 0020/0021/0023–0028 (this
-- database has a history of hand-repaired migration state; the recovery is to
-- replay a migration). Constraint guards match on the constraint's FORM —
-- referencing table + type + referenced table + the exact set of constrained
-- columns — NEVER on its name: `_fkey` (Postgres) vs `_fk` (Drizzle) name drift
-- already broke one production deploy here, and a name-only guard on a drifted
-- database silently adds a DUPLICATE constraint.

-- Step 1: widen `uploads.size`. int4 → int8 forces a table REWRITE under
-- ACCESS EXCLUSIVE — acceptable only because `uploads` is a short-lived staging
-- table (GC-swept, kept for UPLOAD_RETENTION_HOURS), never a growing ledger.
-- Guarded on the current type so a replay is a no-op instead of a second rewrite.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.uploads'::regclass
      AND attname = 'size'
      AND atttypid = 'int4'::regtype
  ) THEN
    ALTER TABLE "uploads" ALTER COLUMN "size" SET DATA TYPE bigint;
  END IF;
END $$;--> statement-breakpoint

-- Step 2: FK-side indexes on `uploads` (org cascade, end-user cascade,
-- created-by SET NULL). Partial where the column is nullable so the dominant
-- NULL population never enters the index.
CREATE INDEX IF NOT EXISTS "idx_uploads_org" ON "uploads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploads_end_user" ON "uploads" USING btree ("end_user_id") WHERE "uploads"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploads_created_by" ON "uploads" USING btree ("created_by") WHERE "uploads"."created_by" IS NOT NULL;--> statement-breakpoint

-- Step 3: FK-side indexes on `documents`. `application_id` is NOT covered by
-- `idx_documents_org_app_created` — it is not that index's leading column.
CREATE INDEX IF NOT EXISTS "idx_documents_end_user" ON "documents" USING btree ("end_user_id") WHERE "documents"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_user" ON "documents" USING btree ("user_id") WHERE "documents"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_application" ON "documents" USING btree ("application_id");--> statement-breakpoint

-- Step 4: referenced target of `document_links`' composite FK below. MUST come
-- before that FK — Postgres requires a unique index on the referenced column
-- pair. Trivially valid: `id` alone is the PK, so `(id, org_id)` can never
-- collide; this only pays an index build.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_documents_id_org_id" ON "documents" USING btree ("id","org_id");--> statement-breakpoint

-- Step 5: composite tenant-integrity FKs on `documents`. Added NOT VALID
-- (Drizzle cannot express it) so no scan happens under the ADD CONSTRAINT lock;
-- migration 0030 does the `VALIDATE CONSTRAINT` under SHARE UPDATE EXCLUSIVE,
-- which does not block writers. NULL container rows pass per MATCH SIMPLE.
-- ON DELETE cascade deliberately mirrors the single-column FKs already on these
-- columns — the service path detaches link-protected documents BEFORE deleting a
-- run, and the cascade is the fallback for the unprotected remainder.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.documents'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.runs'::regclass
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['org_id','run_id']
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_run_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "public"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.documents'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.chat_sessions'::regclass
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['chat_session_id','org_id']
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_chat_session_id_org_id_fk" FOREIGN KEY ("chat_session_id","org_id") REFERENCES "public"."chat_sessions"("id","org_id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint

-- Step 6: `document_links.org_id`. Added NULLABLE, backfilled from the parent
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

-- Step 7: composite tenant-integrity FKs on `document_links` — the link's
-- document AND its consuming run must both belong to the org on the row, which
-- makes a cross-tenant link (and the denial-of-deletion it causes)
-- unrepresentable. NOT VALID + VALIDATE in 0030, as above. The referencing side
-- of both is already covered: the composite PK leads with `document_id`,
-- `idx_document_links_consumer_run` leads with `consumer_run_id`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.document_links'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.documents'::regclass
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['document_id','org_id']
  ) THEN
    ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_org_id_fk" FOREIGN KEY ("document_id","org_id") REFERENCES "public"."documents"("id","org_id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.document_links'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.runs'::regclass
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['consumer_run_id','org_id']
  ) THEN
    ALTER TABLE "document_links" ADD CONSTRAINT "document_links_consumer_run_id_org_id_fk" FOREIGN KEY ("consumer_run_id","org_id") REFERENCES "public"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint

-- Step 8: retention index for the completed tail of the storage-deletion outbox.
CREATE INDEX IF NOT EXISTS "idx_storage_deletion_jobs_completed" ON "storage_deletion_jobs" USING btree ("completed_at") WHERE "storage_deletion_jobs"."completed_at" IS NOT NULL;
