-- Widen the three ids exposed as cursors, and the pointers into them, from
-- int4 to int8.
--
-- WHY. `run_logs.id` is the public `?since=` cursor of `GET /api/runs/{id}/logs`,
-- `llm_usage.id` the billing sweep's watermark (`usage.list({ afterId })`), and
-- `chat_messages.seq` the order of every thread plus the target of the
-- `chat_sessions` read-state pointers. Each is ONE sequence shared by every
-- organization, so the int4 ceiling (2^31 - 1) is a platform-wide limit reached
-- by the sum of all tenants' traffic, not by any one of them. At the ceiling
-- `nextval()` raises and every insert into the table fails. `audit_events.id`
-- has been `bigserial` from the start; these three follow it.
--
-- Both halves move for each id: the column (`ALTER COLUMN … TYPE bigint`) and
-- its sequence (`ALTER SEQUENCE … AS bigint`, whose MAXVALUE a serial pins at
-- the int4 bound). `chat_sessions.last_read_seq` / `last_assistant_seq` hold
-- `chat_messages.seq` values and widen with it. module-ee's claim and watermark
-- columns (`ee_billed_llm_usage.llm_usage_id`, `ee_billing_cursor`) widen in
-- that module's own journal (`drizzle.ee_migrations`, its migration 0008).
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2): no row is rewritten beyond
-- the type change itself, and every int4 value is a valid int8.
--
-- COST. A type change rewrites the table and its indexes under ACCESS
-- EXCLUSIVE: `run_logs` and `llm_usage` are the two largest tables in a
-- long-lived deployment. Rehearse on a production dump to size the window, and
-- check the production type with `scripts/schema-catalog.sql`, not the Drizzle
-- source (#1507).
--
-- ROLLBACK: one-way once any id exceeds 2^31 - 1. Before that, the inverse
-- `ALTER … TYPE integer` / `ALTER SEQUENCE … AS integer` restores the old shape.

ALTER TABLE "run_logs" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER SEQUENCE "run_logs_id_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER SEQUENCE "llm_usage_id_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "seq" SET DATA TYPE bigint;--> statement-breakpoint
ALTER SEQUENCE "chat_messages_seq_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "last_assistant_seq" SET DATA TYPE bigint, ALTER COLUMN "last_read_seq" SET DATA TYPE bigint;
