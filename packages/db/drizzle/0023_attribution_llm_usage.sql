-- Attribution on `llm_usage`: add chat-session context + a credential-source
-- discriminator so every metered LLM call carries who it was for (run OR chat)
-- and which credential set reached the provider (platform "system" vs the
-- org's own "org").
--
-- Every statement is written RE-RUNNABLE. This database has a history of
-- hand-repaired migration state (a future-dated `__drizzle_migrations`
-- watermark that silently skips pending migrations); the recovery for that is
-- to replay a migration, and an unguarded `CREATE TYPE` / `ADD COLUMN` /
-- `ADD CONSTRAINT` / `CREATE INDEX` would then crash-loop the boot on
-- `already exists`. Same discipline as migrations 0020/0021.

-- Enum for the credential-source discriminator. Postgres has no
-- `CREATE TYPE IF NOT EXISTS`, hence the plpgsql guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'credential_source') THEN
    CREATE TYPE "public"."credential_source" AS ENUM('system', 'org');
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "chat_session_id" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "credential_source" "credential_source";--> statement-breakpoint
-- Single-column chat FK — cascade-deletes a ledger row with its session.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_chat_session_id_chat_sessions_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_chat_session_id" ON "llm_usage" USING btree ("chat_session_id");--> statement-breakpoint
-- Referenced target of the composite tenant-integrity FK below. Trivially
-- valid — `id` alone is the PK of `chat_sessions`, so `(id, org_id)` can
-- never collide; this statement only pays an index build.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_sessions_id_org_id" ON "chat_sessions" USING btree ("id","org_id");--> statement-breakpoint
-- Composite tenant-integrity FK (mirror of CRIT-07 for runs): make
-- `llm_usage.chat_session_id` structurally inseparable from `llm_usage.org_id`,
-- so a caller-supplied session id can never attribute LLM spend onto another
-- tenant's session. Added NOT VALID so existing rows are NEVER scanned at
-- apply time (Drizzle cannot express NOT VALID). NULL `chat_session_id` rows
-- (runner / un-attributed proxy calls) pass per MATCH SIMPLE semantics.
-- Enforcement applies to every INSERT/UPDATE from this point on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_chat_session_id_org_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_chat_session_id_org_id_fk" FOREIGN KEY ("chat_session_id","org_id") REFERENCES "public"."chat_sessions"("id","org_id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
-- Single-context invariant: a ledger row is attributed to a run OR a chat
-- session, never both. Trivially valid against existing rows — `chat_session_id`
-- was just added and is NULL everywhere — so this validates immediately.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_context_single'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_context_single" CHECK (run_id IS NULL OR chat_session_id IS NULL);
  END IF;
END $$;--> statement-breakpoint
-- Backfill historical run rows from `runs.model_source` (free-text, only ever
-- 'system' | 'org'). Chat / un-attributed rows have no run and stay NULL —
-- never retro-attributable. Idempotent: the NULL guard makes a replay a no-op.
UPDATE "llm_usage"
SET "credential_source" = "runs"."model_source"::"credential_source"
FROM "runs"
WHERE "llm_usage"."run_id" = "runs"."id"
  AND "llm_usage"."credential_source" IS NULL
  AND "runs"."model_source" IN ('system', 'org');
