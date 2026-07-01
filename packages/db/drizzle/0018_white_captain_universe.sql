ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_at_most_one_actor";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "version_ref" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
UPDATE "runs" SET "version_ref" = CASE WHEN "version_dirty" THEN 'draft' ELSE COALESCE("version_label", 'draft') END;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "version_dirty";--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_exactly_one_actor" CHECK ((user_id IS NOT NULL) <> (end_user_id IS NOT NULL));
