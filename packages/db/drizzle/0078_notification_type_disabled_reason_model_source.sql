CREATE TYPE "public"."schedule_disabled_reason" AS ENUM('actor_invalid', 'actor_left_org', 'connection_deleted');--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "model_source" SET DATA TYPE "public"."credential_source" USING "model_source"::"public"."credential_source";--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN "disabled_reason" "schedule_disabled_reason";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_remote_has_no_platform_model" CHECK (run_origin = 'platform' OR (model_source IS NULL AND model_id IS NULL AND inference_route IS NULL));--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_enabled_has_no_disabled_reason" CHECK (NOT enabled OR disabled_reason IS NULL);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK (type IN ('run_completed', 'package_shared'));