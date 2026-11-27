-- Two changes, no data rewritten (#2437).
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
-- Cost: the six CHECKs are added VALID, so each scans its table once under the ALTER's ACCESS
-- EXCLUSIVE lock. The columns they read are new and NULL, the tables hold one row per connection,
-- credential or organization, and nothing else is rebuilt: no index, no rewrite.
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
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_needs_reconnection_record" CHECK (needs_reconnection OR (needs_reconnection_cause IS NULL AND needs_reconnection_at IS NULL));