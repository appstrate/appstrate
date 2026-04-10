-- Drop denormalized runs.schedule_name — modules now enrich runs via the
-- `enrichRun` hook instead. Keeps core agnostic of module-owned tables.
ALTER TABLE "runs" DROP COLUMN IF EXISTS "schedule_name";
