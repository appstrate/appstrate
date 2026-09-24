-- Widen the int4 cursor ids to int8, column and sequence: `run_logs.id`,
-- `llm_usage.id`, `chat_messages.seq` and the two `chat_sessions` read-state
-- pointers into it. Each sequence is shared by every org, so int4 is a
-- platform-wide ceiling. Shape only; every int4 value is a valid int8.
-- COST: each type change rewrites the table and its indexes under ACCESS
-- EXCLUSIVE, and `run_logs`/`llm_usage` are the largest tables. `lock_timeout`
-- bounds the wait for the lock, not the rewrite. Rehearse on a prod dump to size
-- the window. Rollback is one-way once an id exceeds 2^31 - 1.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "run_logs" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER SEQUENCE "run_logs_id_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER SEQUENCE "llm_usage_id_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "seq" SET DATA TYPE bigint;--> statement-breakpoint
ALTER SEQUENCE "chat_messages_seq_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "last_assistant_seq" SET DATA TYPE bigint, ALTER COLUMN "last_read_seq" SET DATA TYPE bigint;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
