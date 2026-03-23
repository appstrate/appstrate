ALTER TABLE "share_tokens" DROP CONSTRAINT "share_tokens_execution_id_executions_id_fk";
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "share_token_id" text;--> statement-breakpoint
CREATE INDEX "idx_executions_share_token_id" ON "executions" USING btree ("share_token_id");--> statement-breakpoint
ALTER TABLE "share_tokens" DROP COLUMN "execution_id";