-- Remove the legacy connection-profile / app-profile cascade. Integrations
-- now use a flat connections + pins model, so the two profile tables and the
-- profile columns on `runs`, `application_packages`, and `package_schedules`
-- are dead. `package_schedules` gains direct actor columns (user_id /
-- end_user_id) to identify which actor a scheduled run executes as.

-- Drop the profile reference columns first (CASCADE clears dependent FKs/indexes).
ALTER TABLE "runs" DROP COLUMN IF EXISTS "connection_profile_id";--> statement-breakpoint
ALTER TABLE "application_packages" DROP COLUMN IF EXISTS "app_profile_id";--> statement-breakpoint

-- Migrate package_schedules from connection_profile_id to direct actor columns.
ALTER TABLE "package_schedules" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN IF NOT EXISTS "end_user_id" text;--> statement-breakpoint
UPDATE "package_schedules" s
  SET "user_id" = cp."user_id", "end_user_id" = cp."end_user_id"
  FROM "connection_profiles" cp
  WHERE s."connection_profile_id" = cp."id";--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN IF EXISTS "connection_profile_id";--> statement-breakpoint
ALTER TABLE "package_schedules"
  ADD CONSTRAINT "package_schedules_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "package_schedules"
  ADD CONSTRAINT "package_schedules_end_user_id_end_users_id_fk"
  FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "package_schedules"
  ADD CONSTRAINT "package_schedules_at_most_one_actor"
  CHECK (NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_user_id" ON "package_schedules" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_end_user_id" ON "package_schedules" ("end_user_id");--> statement-breakpoint

-- Finally drop the profile tables themselves.
DROP TABLE IF EXISTS "user_application_profiles" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "connection_profiles" CASCADE;
