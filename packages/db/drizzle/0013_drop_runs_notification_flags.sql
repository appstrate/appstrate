DROP INDEX "idx_runs_notification";--> statement-breakpoint
DROP INDEX "idx_runs_unread";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "notified_at";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "read_at";