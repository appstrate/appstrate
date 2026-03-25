ALTER TABLE "share_link_usages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "share_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "share_link_usages" CASCADE;--> statement-breakpoint
DROP TABLE "share_links" CASCADE;--> statement-breakpoint
DROP INDEX "idx_executions_share_link_id";--> statement-breakpoint
ALTER TABLE "executions" DROP COLUMN "share_link_id";