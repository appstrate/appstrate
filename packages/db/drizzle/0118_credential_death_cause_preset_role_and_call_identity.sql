-- Three changes, no data rewritten (#2437).
--
-- 1. A dead credential keeps the cause and the date of its death: `needs_reconnection_cause` and
--    `needs_reconnection_at` on `integration_connections` and `model_provider_credentials`, written
--    in the same UPDATE that flips `needs_reconnection` and cleared with it. Rows flagged before
--    this migration have no cause and no date (NULL), which the record CHECK allows.
-- 2. The personal-space default preset role moves from `org_settings.personal_space_role` into the
--    typed column `organizations.personal_space_preset_role`, beside `personal_space_role_id`.
--    `scripts/migration/0060-personal-space-preset-role.ts` moves the stored keys; the platform
--    refuses to boot until it has run.
--
-- 3. Each `connection_calls` row names its call: `called_at` is when the upstream call started and
--    `call_id` a UUIDv7 the writer mints (a run's sidecar, or the platform's credential proxy). Rows
--    recorded before this migration keep both NULL (not recorded; no backfill). `request_id` turns
--    nullable: a row reported by a run's sidecar carries none, since its batch POST's id names no
--    call. The unique index makes the sidecar's retried POST store each call once.
--
-- LOCK AND COST. The six CHECKs of 1 and 2 are added VALID: each scans its table once under the
-- ALTER's ACCESS EXCLUSIVE lock, on tables that hold one row per connection, credential or
-- organization. The unique index of 3 is never CONCURRENTLY (drizzle wraps the batch in a transaction;
-- see 0041's header): it takes SHARE on `connection_calls`, blocking the journal's INSERTs until the
-- batch commits. It is partial on `call_id IS NOT NULL`, so it indexes no existing row but still
-- scans the whole table once; `connection_calls` has no retention (#1945), so the scan scales with
-- its row count. Release instruction: time it with 0116's two builds on a restored production dump
-- and size the deploy window on the total. Every column change is catalog-only (no rewrite).
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_personal_space_role_preset";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_personal_space_role_one_shape";--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD COLUMN "needs_reconnection_cause" text;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD COLUMN "needs_reconnection_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "personal_space_preset_role" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "needs_reconnection_cause" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "needs_reconnection_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_needs_reconnection_cause_valid" CHECK (needs_reconnection_cause IS NULL OR needs_reconnection_cause IN ('refresh_token_revoked', 'refresh_token_missing', 'refresh_failures_exhausted', 'unrefreshable', 'credentials_undecryptable'));--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_needs_reconnection_record" CHECK (needs_reconnection OR (needs_reconnection_cause IS NULL AND needs_reconnection_at IS NULL));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_space_preset_valid" CHECK (personal_space_preset_role IS NULL OR personal_space_preset_role IN ('admin', 'builder', 'operator', 'runner', 'viewer'));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_space_role_one_shape" CHECK (num_nonnulls(personal_space_preset_role, personal_space_role_id) <= 1);--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_needs_reconnection_cause_valid" CHECK (needs_reconnection_cause IS NULL OR needs_reconnection_cause IN ('refresh_token_revoked', 'refresh_token_missing', 'refresh_failures_exhausted', 'unrefreshable', 'credentials_undecryptable'));--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_needs_reconnection_record" CHECK (needs_reconnection OR (needs_reconnection_cause IS NULL AND needs_reconnection_at IS NULL));--> statement-breakpoint
ALTER TABLE "connection_calls" ALTER COLUMN "request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "called_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "call_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connection_calls_run_call" ON "connection_calls" USING btree ("run_id","call_id") WHERE "connection_calls"."call_id" IS NOT NULL;
