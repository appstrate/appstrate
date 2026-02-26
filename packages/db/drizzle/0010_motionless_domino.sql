ALTER TABLE "executions" ADD COLUMN "notified_at" timestamp;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "read_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_executions_notification" ON "executions" USING btree ("user_id","org_id","notified_at","read_at");