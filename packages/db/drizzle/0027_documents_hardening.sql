-- Documents hardening: run artifact summary, the storage-deletion outbox, the
-- per-org document byte budget, and end-user / checksum attribution on staged
-- uploads.
--
-- Every statement is RE-RUNNABLE, same discipline as 0020/0021/0023–0026: this
-- database has a history of hand-repaired migration state, and the recovery is
-- to replay a migration — unguarded `CREATE TABLE` / `ADD COLUMN` /
-- `ADD CONSTRAINT` / `CREATE INDEX` would crash-loop the boot on
-- `... already exists`.
--
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "artifacts" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_deletion_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_storage_deletion_jobs_due" ON "storage_deletion_jobs" USING btree ("next_attempt_at") WHERE "storage_deletion_jobs"."completed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_storage_deletion_jobs_pending" ON "storage_deletion_jobs" USING btree ("bucket","storage_key") WHERE "storage_deletion_jobs"."completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "documents_bytes_limit" bigint;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN IF NOT EXISTS "end_user_id" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN IF NOT EXISTS "sha256" text;--> statement-breakpoint
-- Validates immediately (no NOT VALID): the column it constrains is created by
-- the statement two lines above, so it is NULL on every pre-existing row and the
-- scan finds nothing to check. Deferring it to a later `VALIDATE CONSTRAINT`
-- would buy nothing — the boot migrator applies every pending migration in ONE
-- transaction, so the ACCESS EXCLUSIVE lock this statement takes is held until
-- that transaction commits either way.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uploads_end_user_id_end_users_id_fk'
      AND conrelid = 'public.uploads'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
