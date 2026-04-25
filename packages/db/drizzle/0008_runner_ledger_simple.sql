-- 0008_runner_ledger_simple.sql
--
-- Drop the runner-row sequence column + transactional delta scheme.
--
-- Pre-change: runner-source rows used `(run_id, sequence)` as their dedup
-- key, with the per-row `cost_usd` storing a delta against the previously
-- persisted SUM. The scheme existed to keep `SUM(ledger)` correct under a
-- hypothetical multi-event running-total stream that never materialised.
--
-- Post-change: at most one runner-source row per run, dedup on `(run_id)`
-- alone. The metric event handler and the finalize-time fallback compete
-- via ON CONFLICT DO NOTHING — whichever lands first owns the row, the
-- other is a no-op. The row's `cost_usd` is the canonical runner cost.
-- Future multi-segment metrics (multi-turn agents, …) are an additive
-- redesign at that point, not a rollback of this one.

DROP INDEX IF EXISTS "uq_llm_usage_runner_run_sequence";

ALTER TABLE "llm_usage" DROP CONSTRAINT IF EXISTS "llm_usage_runner_has_sequence";

ALTER TABLE "llm_usage" DROP COLUMN IF EXISTS "sequence";

ALTER TABLE "llm_usage"
  ADD CONSTRAINT "llm_usage_runner_has_run_id"
  CHECK (source <> 'runner' OR run_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_llm_usage_runner_run_id"
  ON "llm_usage" ("run_id")
  WHERE source = 'runner' AND run_id IS NOT NULL;
