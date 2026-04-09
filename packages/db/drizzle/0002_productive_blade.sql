ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_package_version_id_package_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "version_label" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "version_dirty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "package_version_id";