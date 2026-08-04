ALTER TABLE "application_packages" ADD COLUMN "generation_config" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "generation_config" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "generation_config_override" jsonb;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN "generation_config_override" jsonb;