ALTER TABLE "runs" ADD COLUMN "dependency_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN "dependency_overrides" jsonb;