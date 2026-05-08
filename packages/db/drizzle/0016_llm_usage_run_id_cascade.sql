-- Switch `llm_usage.run_id` FK from `ON DELETE SET NULL` to `ON DELETE CASCADE`.
--
-- Resolves a schema-level contradiction with the `llm_usage_runner_has_run_id`
-- check constraint: the check forbids NULL run_id on rows where source='runner',
-- but the SET NULL cascade tries to NULL exactly that column when a run is
-- deleted. Net effect: any DELETE /api/packages/agents/{scope}/{name} on a
-- package whose runs had emitted runner-source llm_usage rows threw a CHECK
-- violation, surfaced as a generic 500 with no detail. See BUGS-EVO §1.2.
--
-- CASCADE is the right semantics: an llm_usage row is solidary of its run
-- (no analytical value if the run is gone), and cascading the delete satisfies
-- both the FK and the runner-has-run-id invariant.
--
-- Idempotent: drops the existing FK if present and re-creates it. Safe to
-- replay on installs that have already applied an older shape.

ALTER TABLE "llm_usage"
  DROP CONSTRAINT IF EXISTS "llm_usage_run_id_runs_id_fk";

ALTER TABLE "llm_usage"
  ADD CONSTRAINT "llm_usage_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;
