-- Scheduling module: initial schema
-- Uses IF NOT EXISTS for backward compatibility with existing installs
-- where core migrations already created this table.

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
