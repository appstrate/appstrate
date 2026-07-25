-- Detach-on-delete for the `llm_usage` billing ledger. A ledger row is an
-- org-level accounting fact billed AFTER the fact by a cursor consumer (the
-- cloud module sweeps `services.usage.list` on a periodic tick). Deleting a run
-- or chat session — user-triggerable via DELETE /agents/:scope/:name/runs, a
-- chat-session delete, or a direct run delete — must therefore lose the row's
-- CONTEXT, never its existence, otherwise a not-yet-swept row is erased and its
-- spend escapes billing. This migration flips both context FKs from CASCADE to
-- SET NULL and drops the CHECK that forced the cascade. Org deletion keeps full
-- CASCADE (org_id FK, unchanged) — total teardown is accepted.
--
-- The composite tenant-integrity FKs use the PostgreSQL 15+ column-list form
-- `ON DELETE SET NULL (context_col)` so only the context column is nulled and
-- the NOT-NULL `org_id` is left intact (a plain composite SET NULL would try to
-- null org_id too and abort). Drizzle cannot express the column list, so the
-- authoritative DELETE action for the composite FKs lives ONLY in this raw SQL.
--
-- Every statement is RE-RUNNABLE (this fleet has hand-repaired migration state):
-- constraints are dropped IF EXISTS under BOTH the Drizzle `_fk` name and the
-- legacy Postgres `_fkey` name (they drift on old databases), then re-added only
-- when absent. A replay reproduces the same end state.

-- Step 1: drop the runner-has-run-id CHECK. A detached runner row legitimately
-- carries run_id NULL; the birth invariant (a runner row is INSERTed with a
-- run_id) is upheld by the single ledger writer `recordLlmUsage`, not the DB.
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_runner_has_run_id";--> statement-breakpoint

-- Step 2: single-column run FK → SET NULL.
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_run_id_runs_id_fkey";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_run_id_runs_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE SET NULL ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- Step 3: single-column chat-session FK → SET NULL.
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_chat_session_id_chat_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_chat_session_id_chat_sessions_id_fkey";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_chat_session_id_chat_sessions_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE SET NULL ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- Step 4: composite tenant-integrity run FK → SET NULL (run_id) column-list.
-- Re-added NOT VALID (never scans legacy rows at apply time), then VALIDATEd in
-- a guarded step so a replay is a no-op and the every-row invariant established
-- by migration 0021 is restored.
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_run_id_org_id_fk";--> statement-breakpoint
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_run_id_org_id_fkey";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_run_id_org_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "public"."runs"("id","org_id") ON DELETE SET NULL ("run_id") ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT (
    SELECT convalidated FROM pg_constraint
    WHERE conname = 'llm_usage_run_id_org_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" VALIDATE CONSTRAINT "llm_usage_run_id_org_id_fk";
  END IF;
END $$;--> statement-breakpoint

-- Step 5: composite tenant-integrity chat FK → SET NULL (chat_session_id).
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_chat_session_id_org_id_fk";--> statement-breakpoint
ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_chat_session_id_org_id_fkey";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'llm_usage_chat_session_id_org_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_chat_session_id_org_id_fk" FOREIGN KEY ("chat_session_id","org_id") REFERENCES "public"."chat_sessions"("id","org_id") ON DELETE SET NULL ("chat_session_id") ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT (
    SELECT convalidated FROM pg_constraint
    WHERE conname = 'llm_usage_chat_session_id_org_id_fk'
      AND conrelid = 'public.llm_usage'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "llm_usage" VALIDATE CONSTRAINT "llm_usage_chat_session_id_org_id_fk";
  END IF;
END $$;
