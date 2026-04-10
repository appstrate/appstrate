-- Add denormalized schedule_name to runs (avoids LEFT JOIN on module-owned table)
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "schedule_name" text;
--> statement-breakpoint
-- Backfill existing runs from package_schedules (if table exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'package_schedules') THEN
    UPDATE "runs" SET "schedule_name" = ps."name"
    FROM "package_schedules" ps
    WHERE "runs"."schedule_id" = ps."id" AND "runs"."schedule_name" IS NULL;
  END IF;
END $$;
--> statement-breakpoint
-- Drop the FK constraint from runs.schedule_id → package_schedules.id
-- (scheduling module now owns this FK in its own migrations)
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_schedule_id_package_schedules_id_fk";
