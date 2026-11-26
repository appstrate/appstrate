-- The background refresh sweep's visit stamp. NULL = never visited, so due: no backfill.
-- `model_provider_credentials.needs_reconnection` mirrors the blob's death flag, as `expires_at` mirrors its expiry.
ALTER TABLE "integration_connections" ADD COLUMN "refresh_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD COLUMN "refresh_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD COLUMN "needs_reconnection" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_conn_refresh_due" ON "integration_connections" USING btree ("expires_at") WHERE "integration_connections"."client_ref" IS NOT NULL AND NOT "integration_connections"."needs_reconnection" AND "integration_connections"."expires_at" IS NOT NULL;--> statement-breakpoint
-- `credential_needs_reconnection`: the bell notice an integration connection's owner gets when the
-- connection dies. The kind CHECK names every value of `notificationTypeValues`.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK (type IN ('run_failed', 'package_shared', 'agent_message', 'credential_needs_reconnection'));
