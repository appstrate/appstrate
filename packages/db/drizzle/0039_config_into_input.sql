ALTER TABLE "application_packages" RENAME COLUMN "config" TO "input_settings";--> statement-breakpoint
ALTER TABLE "application_packages" ALTER COLUMN "input_settings" SET DEFAULT '{"values":{},"locked":[]}'::jsonb;--> statement-breakpoint
UPDATE "application_packages" SET "input_settings" = jsonb_build_object('values', "input_settings", 'locked', '[]'::jsonb);--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "config";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "config_override";--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN "config_override";
