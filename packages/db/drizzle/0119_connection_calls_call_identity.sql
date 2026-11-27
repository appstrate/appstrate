-- Each journal row names its call (#2437): `called_at` is when the upstream call started and
-- `call_id` a UUIDv7 the writer mints (a run's sidecar, or the platform's credential proxy). Rows
-- recorded before this migration keep both NULL (not recorded; no backfill). `request_id` turns
-- nullable: a row reported by a run's sidecar carries none, since its batch POST's id names no call.
-- The unique index makes the sidecar's retried POST store each call once (`ON CONFLICT DO NOTHING`).
--
-- LOCK AND COST. The unique index is never CONCURRENTLY (drizzle wraps the batch in a transaction;
-- see 0041's header): it takes SHARE on `connection_calls`, blocking the journal's INSERTs until the
-- batch commits. It is partial on `call_id IS NOT NULL`, so it indexes no existing row but still
-- scans the whole table once; `connection_calls` has no retention (#1945), so the scan scales with
-- its row count. Release instruction: time it with 0116's two builds on a restored production dump
-- and size the deploy window on the total. The column changes are catalog-only (no rewrite).
ALTER TABLE "connection_calls" ALTER COLUMN "request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "called_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "call_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connection_calls_run_call" ON "connection_calls" USING btree ("run_id","call_id") WHERE "connection_calls"."call_id" IS NOT NULL;