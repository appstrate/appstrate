-- The background refresh sweep's visit stamp. NULL = never visited, so due: no backfill.
ALTER TABLE "integration_connections" ADD COLUMN "refresh_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD COLUMN "refresh_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_integration_conn_refresh_due" ON "integration_connections" USING btree ("expires_at") WHERE "integration_connections"."client_ref" IS NOT NULL AND NOT "integration_connections"."needs_reconnection" AND "integration_connections"."expires_at" IS NOT NULL;
