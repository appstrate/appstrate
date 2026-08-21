ALTER TABLE "application_packages" ADD COLUMN "locked_fields" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "config";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "config_override";--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN "config_override";