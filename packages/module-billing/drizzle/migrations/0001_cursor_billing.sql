-- Cursor-based billing schema migration (transforms the 0000 baseline).
--
-- PRODUCTION DATA EXISTS: this is an incremental, RE-RUNNABLE migration, not a
-- regenerated init. Every statement is guarded (IF EXISTS / IF NOT EXISTS /
-- information_schema checks) so a partial apply or a double-run is a no-op.
--
--   * cloud_billing_cursor   — NEW single-row watermark table.
--   * cloud_usage_records    — run_id  =>  (context_type, context_id); existing
--                              rows backfilled to ('run', run_id).
--   * cloud_billed_llm_usage — DROP run_id (+ its index).
--   * cloud_pending_bills    — DROPPED (retry queue replaced by the cursor).

-- 1. New single-row watermark table for the cursor sweep.
CREATE TABLE IF NOT EXISTS "cloud_billing_cursor" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"last_llm_usage_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_billing_cursor_single_row" CHECK ("cloud_billing_cursor"."id")
);
--> statement-breakpoint

-- 2. cloud_usage_records: add the generic (context_type, context_id) key.
--    Added NULLABLE first so the ADD succeeds on a table that already holds
--    rows; backfilled below, then promoted to NOT NULL.
ALTER TABLE "cloud_usage_records" ADD COLUMN IF NOT EXISTS "context_type" text;--> statement-breakpoint
ALTER TABLE "cloud_usage_records" ADD COLUMN IF NOT EXISTS "context_id" text;--> statement-breakpoint

-- 3. Backfill existing rows: every legacy row is a run, keyed by its run_id.
--    Guarded on run_id still existing (so a re-run after the DROP COLUMN below
--    is a no-op) and on context_id IS NULL (idempotent — already-migrated rows
--    are skipped).
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'cloud_usage_records' AND column_name = 'run_id'
	) THEN
		UPDATE "cloud_usage_records"
		SET "context_type" = 'run', "context_id" = "run_id"
		WHERE "context_id" IS NULL;
	END IF;
END $$;--> statement-breakpoint

-- 4. Promote to NOT NULL (idempotent — SET NOT NULL is a no-op if already set).
ALTER TABLE "cloud_usage_records" ALTER COLUMN "context_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_usage_records" ALTER COLUMN "context_id" SET NOT NULL;--> statement-breakpoint

-- 5. Swap the idempotency index: drop the run_id unique index, add the
--    (context_type, context_id) one.
DROP INDEX IF EXISTS "uq_cloud_usage_records_run_id";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cloud_usage_records_context" ON "cloud_usage_records" USING btree ("context_type","context_id");--> statement-breakpoint

-- 6. Drop the now-unused run_id column.
ALTER TABLE "cloud_usage_records" DROP COLUMN IF EXISTS "run_id";--> statement-breakpoint

-- 6b. Cumulative raw-dollar total per context — the delta-billing basis. Credits
--     are billed as the delta between dollarsToCredits(new cost_usd) and the
--     already-debited cost_credits, so a context's sub-credit remainder carries
--     forward across passes instead of flooring to 0 each pass. DEFAULT 0 lets
--     the ADD succeed on a populated table; the backfill below then restores the
--     invariant cost_credits ≈ round(cost_usd * 1000) for legacy rows.
ALTER TABLE "cloud_usage_records" ADD COLUMN IF NOT EXISTS "cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint

-- 6c. Backfill legacy rows (billed by the old afterRun model, so cost_usd = 0
--     while cost_credits > 0). Left unbackfilled, a legacy context that later
--     received new rows would have its cost_credits overwritten with only the
--     post-cutover cumulative, dropping the historical credits. Set cost_usd to
--     the whole-credit equivalent (cost_credits / 1000); the dropped sub-credit
--     remainder is unknowable and assumed 0. Guarded + re-runnable: only touches
--     rows still at DEFAULT 0 with credits already debited, so a re-run (or a row
--     that legitimately cost $0) is a no-op.
UPDATE "cloud_usage_records" SET "cost_usd" = "cost_credits" / 1000.0 WHERE "cost_usd" = 0 AND "cost_credits" > 0;--> statement-breakpoint

-- 7. cloud_billed_llm_usage: run_id is no longer denormalised (the cursor sweep
--    reads attribution from the platform ledger, not this side-car).
DROP INDEX IF EXISTS "idx_cloud_billed_llm_usage_run_id";--> statement-breakpoint
ALTER TABLE "cloud_billed_llm_usage" DROP COLUMN IF EXISTS "run_id";--> statement-breakpoint

-- 8. Drop the retry queue — superseded by the cursor watermark (a failed sweep
--    pass simply retries from the last committed id). Guard FIRST: a non-empty
--    queue holds failed debits still awaiting retry, and their source ledger rows
--    sit below the new cursor (so they'd never be billed again). Dropping it
--    silently would destroy that unbilled work — refuse and make an operator
--    drain it. Re-runnable: after the drop to_regclass is NULL and the guard
--    no-ops, so a re-apply after a partial failure completes.
DO $$
BEGIN
	IF to_regclass('cloud_pending_bills') IS NOT NULL
		AND EXISTS (SELECT 1 FROM cloud_pending_bills) THEN
		RAISE EXCEPTION 'cloud_pending_bills is not empty — drain or manually resolve pending bills before migrating (see PR #34)';
	END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "cloud_pending_bills" CASCADE;
