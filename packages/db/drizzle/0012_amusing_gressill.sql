ALTER TABLE "runs" ADD COLUMN "resolved_integration_versions" jsonb;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN "dependency_overrides" jsonb;