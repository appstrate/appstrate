-- The conversation whose loopback bearer issued a credential-proxy call. Existing rows stay NULL
-- (not recorded); a row names a run or a conversation, never both. The two partial indexes serve
-- the reads that filter by conversation and by run. A NULL `host` is an operation of a local MCP
-- server, whose upstream requests the journal does not see.
ALTER TABLE "connection_calls" ADD COLUMN "chat_session_id" text;--> statement-breakpoint
CREATE INDEX "idx_connection_calls_chat_session_id" ON "connection_calls" USING btree ("chat_session_id","id") WHERE "connection_calls"."chat_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_connection_calls_run_id" ON "connection_calls" USING btree ("run_id","id") WHERE "connection_calls"."run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ALTER COLUMN "host" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_one_context" CHECK (run_id IS NULL OR chat_session_id IS NULL);
