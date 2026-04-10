-- Drop the legacy FK constraint from runs.schedule_id → package_schedules.id.
-- The scheduling module now owns this FK in its own migration.
--
-- NOTE: this file previously also added a `schedule_name` column as a JOIN-free
-- display optimization. That denormalization is gone — modules enrich runs via
-- the `enrichRun` hook, so core runs stays agnostic of module-owned tables.
-- The DROP COLUMN for `schedule_name` lives in 0005 to cleanly handle installs
-- that already applied the denormalization step.
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_schedule_id_package_schedules_id_fk";
