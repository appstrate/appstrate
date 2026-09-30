CREATE TYPE "public"."schedule_disabled_reason" AS ENUM('user', 'actor_invalid', 'actor_left_org', 'connection_deleted');--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "model_source" SET DATA TYPE "public"."credential_source" USING "model_source"::"public"."credential_source";--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN "disabled_reason" "schedule_disabled_reason";--> statement-breakpoint
UPDATE "package_schedules" SET "disabled_reason" = 'user' WHERE "enabled" = false;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_remote_has_no_platform_model" CHECK (run_origin = 'platform' OR (model_source IS NULL AND model_id IS NULL AND inference_route IS NULL));--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_disabled_reason_matches" CHECK (enabled = (disabled_reason IS NULL));