-- Scheduling module: FK constraints to core tables.
-- Uses DO blocks for idempotency (existing installs already have these FKs from core migrations).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'package_schedules_package_id_fk') THEN
    ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_package_id_fk"
      FOREIGN KEY ("package_id") REFERENCES "packages" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'package_schedules_connection_profile_id_fk') THEN
    ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_connection_profile_id_fk"
      FOREIGN KEY ("connection_profile_id") REFERENCES "connection_profiles" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'package_schedules_org_id_fk') THEN
    ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'package_schedules_application_id_fk') THEN
    ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_application_id_fk"
      FOREIGN KEY ("application_id") REFERENCES "applications" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
-- Also ensure the runs.schedule_id FK is set (was previously managed by core)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_schedule_id_package_schedules_fk') THEN
    ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_package_schedules_fk"
      FOREIGN KEY ("schedule_id") REFERENCES "package_schedules" ("id") ON DELETE SET NULL;
  END IF;
END $$;
