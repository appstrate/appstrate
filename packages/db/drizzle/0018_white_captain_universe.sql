ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_at_most_one_actor";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "version_ref" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
UPDATE "runs" SET "version_ref" = CASE WHEN "version_dirty" THEN 'draft' ELSE COALESCE("version_label", 'draft') END;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "version_dirty";--> statement-breakpoint
-- Exactly-one-actor CHECK. This runs a validating scan against existing
-- `package_schedules` rows; a pre-existing actor-less row (both user_id and
-- end_user_id NULL) makes the ADD CONSTRAINT abort.
--
-- HISTORICAL NOTE (do not act on this comment — this migration is already
-- applied in production and its SQL is immutable; the note is corrected, the
-- statement is not). The original comment claimed the repo had "no production
-- data" and that the scan would therefore always see zero rows. That was
-- WRONG: production exists and holds real data, and it had exactly one
-- actor-less `package_schedules` row, which would have aborted this statement.
-- The release that shipped this migration only succeeded because the row was
-- found and backfilled (user_id := the org owner) BEFORE the deploy.
--
-- Lesson for FUTURE migrations: a validating ADD CONSTRAINT is data-dependent.
-- Audit production rows first, or add the constraint NOT VALID and VALIDATE it
-- in a maintenance window — the pattern migrations 0020/0021 use.
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_exactly_one_actor" CHECK ((user_id IS NOT NULL) <> (end_user_id IS NOT NULL));
