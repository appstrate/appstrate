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
-- Constraint guards match on the constraint's FORM (referencing table +
-- constraint type + referenced table + the exact set of constrained columns),
-- never on its name — `_fkey` (Postgres) vs `_fk` (Drizzle) name drift already
-- broke one production deploy here, and a name-only guard on a drifted database
-- silently adds a DUPLICATE constraint.
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
-- Added NOT VALID. The column it constrains is created by the statement two
-- lines above, so it is NULL on every pre-existing row and validation is
-- guaranteed to succeed — but an unqualified `ADD CONSTRAINT ... FOREIGN KEY`
-- still seq-scans the whole of `uploads` (and takes SHARE ROW EXCLUSIVE on
-- `end_users` too) to prove it. NOT VALID skips the scan entirely while
-- enforcing the constraint on every INSERT/UPDATE from here on; migration 0030
-- performs the `VALIDATE CONSTRAINT` under the far weaker SHARE UPDATE
-- EXCLUSIVE lock, which does not block writers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.uploads'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.end_users'::regclass
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['end_user_id']
  ) THEN
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;
