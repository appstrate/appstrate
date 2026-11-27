-- The conversation whose loopback bearer issued a credential-proxy call. Existing rows stay NULL
-- (not recorded); a row names a run or a conversation, never both. The two partial indexes serve
-- the reads that filter by conversation and by run. A NULL `host` is an operation of a local MCP
-- server, whose upstream requests the journal does not see.
--
-- LOCK AND COST. The two `CREATE INDEX` statements below are never CONCURRENTLY (Postgres forbids
-- it inside a transaction block and drizzle wraps the pending batch in one; see 0041's header):
-- each takes SHARE on `connection_calls`, which blocks the journal's INSERTs until the batch
-- commits. Both are partial, so each scans the whole table and indexes only the rows that name a
-- run (`chat_session_id` is NULL on every existing row, so the first indexes nothing). `connection_calls`
-- has no retention (#1945): the build time scales with its row count. The CHECK scans the table
-- once more inside the same batch.
ALTER TABLE "connection_calls" ADD COLUMN "chat_session_id" text;--> statement-breakpoint
CREATE INDEX "idx_connection_calls_chat_session_id" ON "connection_calls" USING btree ("chat_session_id","id") WHERE "connection_calls"."chat_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_connection_calls_run_id" ON "connection_calls" USING btree ("run_id","id") WHERE "connection_calls"."run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ALTER COLUMN "host" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_one_context" CHECK (run_id IS NULL OR chat_session_id IS NULL);
