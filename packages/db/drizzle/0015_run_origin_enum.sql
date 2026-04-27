-- Promote `runs.run_origin` from a `text` column with an inline CHECK
-- constraint to a proper PostgreSQL enum type. The CHECK constraint enforced
-- the closed set `('platform', 'remote')` from the application side; the
-- enum hoists that contract into the type system so the Drizzle schema +
-- the `zRunOriginEnum` Zod validator share a single tuple of values.
--
-- Idempotent: skips the conversion when the enum already exists (re-runs
-- in dev where the migration runner replays without resetting state).

DO $$ BEGIN
  CREATE TYPE "run_origin" AS ENUM ('platform', 'remote');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Drop the old CHECK constraint before swapping the column type.
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_run_origin_valid";

-- Drop the old DEFAULT (`text 'platform'`) before the type swap so PG
-- doesn't reject the implicit cast — we re-add it as the enum literal
-- after the column conversion.
ALTER TABLE "runs" ALTER COLUMN "run_origin" DROP DEFAULT;

ALTER TABLE "runs"
  ALTER COLUMN "run_origin" TYPE "run_origin"
  USING "run_origin"::"run_origin";

ALTER TABLE "runs" ALTER COLUMN "run_origin" SET DEFAULT 'platform';
