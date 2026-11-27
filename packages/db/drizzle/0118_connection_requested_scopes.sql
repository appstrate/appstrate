-- The scopes a server asked for that the connection does not hold (step-up demand). Empty = none: no backfill.
ALTER TABLE "integration_connections" ADD COLUMN "requested_scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- The owner's notice of a new demand: one unread per (recipient, connection).
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_scopes_requested_unread" ON "notifications" USING btree ("recipient_type","recipient_id",("payload"->>'connection_id')) WHERE "notifications"."type" = 'connection_scopes_requested' AND "notifications"."read_at" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK (type IN ('run_failed', 'package_shared', 'agent_message', 'credential_needs_reconnection', 'integration_tools_review', 'connection_scopes_requested'));
