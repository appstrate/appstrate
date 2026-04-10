-- Scheduling moves back into core (from the short-lived "scheduling module"
-- iteration). Existing installs that ran the scheduling module's migrations
-- already have the `package_schedules` table plus its FKs. Fresh installs
-- have nothing. Every statement is idempotent so both paths converge on the
-- same final state.

CREATE TABLE IF NOT EXISTS "package_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "package_id" text NOT NULL,
  "connection_profile_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "application_id" text NOT NULL,
  "name" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "cron_expression" text NOT NULL,
  "timezone" text DEFAULT 'UTC',
  "input" jsonb,
  "last_run_at" timestamp,
  "next_run_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_package_id" ON "package_schedules" USING btree ("package_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_connection_profile_id" ON "package_schedules" USING btree ("connection_profile_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_package_schedules_org_id" ON "package_schedules" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_package_schedules_app_id" ON "package_schedules" USING btree ("application_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_package_id_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_connection_profile_id_connection_profiles_id_fk"
    FOREIGN KEY ("connection_profile_id") REFERENCES "connection_profiles"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_application_id_applications_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_package_schedules_id_fk"
    FOREIGN KEY ("schedule_id") REFERENCES "package_schedules"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
