-- The presentation column starts NULL for every existing row. Keep the
-- migration replay-safe: production databases have occasionally needed a
-- migration to be resumed after a manually repaired watermark.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "presentation" text;--> statement-breakpoint

-- The boot migrator applies each migration in one transaction, so PostgreSQL
-- cannot use CREATE INDEX CONCURRENTLY here. This partial index contains no
-- legacy entries (the new column is NULL above) and is the database-level
-- serialization guard for all future primary selections.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_documents_run_primary" ON "documents" USING btree ("run_id") WHERE "documents"."presentation" = 'primary';--> statement-breakpoint

-- New writes are checked immediately. Existing rows all have presentation
-- NULL, so they satisfy the constraint by construction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_documents_presentation'
      AND conrelid = 'public.documents'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "chk_documents_presentation" CHECK ("documents"."presentation" IS NULL OR ("documents"."presentation" = 'primary' AND "documents"."purpose" = 'agent_output' AND "documents"."run_id" IS NOT NULL AND "documents"."chat_session_id" IS NULL));
  END IF;
END $$;
