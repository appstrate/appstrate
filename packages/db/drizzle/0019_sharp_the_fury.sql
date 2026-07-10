-- CRIT-07 tenant-integrity guard: make `llm_usage.run_id` structurally
-- inseparable from `llm_usage.org_id`, so a ledger row attributed to a run
-- can only ever carry that run's own org — a caller-supplied run id can
-- never bill LLM spend onto another tenant's run.
--
-- Both statements are written to be RE-RUNNABLE. This database has a history
-- of hand-repaired migration state (a future-dated `__drizzle_migrations`
-- watermark that silently skips pending migrations); the recovery for that is
-- to replay a migration, and an unguarded `CREATE INDEX` / `ADD CONSTRAINT`
-- would then crash-loop the boot on `already exists`.
--
-- Step 1: unique index on runs(id, org_id) — the composite FK's referenced
-- target. Trivially valid against existing rows ("id" alone is the primary
-- key, so the pair can never collide); this statement CANNOT fail on legacy
-- data, it only pays an index build.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_runs_id_org_id" ON "runs" USING btree ("id","org_id");--> statement-breakpoint
-- Step 2: the composite FK itself, added NOT VALID so existing rows are
-- NEVER scanned at apply time — a legacy `llm_usage` row whose org_id
-- drifted from its run's org (the exact defect this constraint closes)
-- cannot abort the migration on a production database. Enforcement applies
-- to every INSERT/UPDATE from this point on. NULL run_id rows
-- (un-attributed proxy calls) pass per MATCH SIMPLE semantics. ON DELETE
-- CASCADE mirrors the existing single-column `llm_usage_run_id_runs_id_fk`.
-- Follow-up (deliberate, out of band): audit legacy rows for
-- run/org mismatches, repair or delete them, then run
--   ALTER TABLE "llm_usage" VALIDATE CONSTRAINT "llm_usage_run_id_org_id_fk";
-- in a maintenance window. (Migration 0020 does exactly that.)
--
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, hence the plpgsql guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'llm_usage_run_id_org_id_fk'
  ) THEN
    ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "public"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;
