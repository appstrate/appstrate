-- Unified `documents` store — durable deliverables + materialized uploads.
--
-- Every statement is written RE-RUNNABLE, same discipline as migrations
-- 0020/0021/0023. This database has a history of hand-repaired migration state
-- (a future-dated `__drizzle_migrations` watermark that silently skips pending
-- migrations); the recovery for that is to replay a migration, and an unguarded
-- `CREATE TYPE` / `CREATE TABLE` / `ADD COLUMN` / `ADD CONSTRAINT` /
-- `CREATE INDEX` would then crash-loop the boot on `... already exists`.
--
-- Every FK / index below targets a table created in THIS migration, so none of
-- them can scan pre-existing rows: no NOT VALID is needed. The FKs are declared
-- INLINE in the `CREATE TABLE` — with their explicit Drizzle names, so nothing
-- drifts — rather than as separate guarded `ADD CONSTRAINT`s: `CREATE TABLE IF
-- NOT EXISTS` short-circuits on replay, and if the table already exists its own
-- constraints necessarily do too. One guard, not seven, and they cannot diverge.

-- Postgres has no `CREATE TYPE IF NOT EXISTS`, hence the plpgsql guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_purpose') THEN
    CREATE TYPE "public"."document_purpose" AS ENUM('user_upload', 'agent_output');
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"purpose" "document_purpose" NOT NULL,
	"run_id" text,
	"chat_session_id" text,
	"package_id" text,
	"user_id" text,
	"end_user_id" text,
	"storage_key" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "documents_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "documents_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "documents_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "documents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "documents_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "documents_bytes_used" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_org_app_created" ON "documents" USING btree ("org_id","application_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_run" ON "documents" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_chat_session" ON "documents" USING btree ("chat_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_expires" ON "documents" USING btree ("expires_at") WHERE "documents"."expires_at" IS NOT NULL;
