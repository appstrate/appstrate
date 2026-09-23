-- Replace `webhook_deliveries (webhook_id)` with `(webhook_id, created_at, id)`,
-- so the keyset-paginated `GET /api/webhooks/{id}/deliveries` seeks instead of
-- sorting the webhook's whole history; the composite's leading column serves
-- every other read, so the narrow index goes.
-- COST: plain CREATE INDEX (drizzle runs in a transaction) holds SHARE on the
-- table, blocking delivery INSERTs for the build, which is as large as the
-- history. The timeouts bound it; on expiry the deploy fails: retry.
-- Rehearse on a prod dump. `IF [NOT] EXISTS` lets a partial apply converge.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook_created" ON "webhook_deliveries" USING btree ("webhook_id","created_at","id");--> statement-breakpoint
DROP INDEX IF EXISTS "idx_webhook_deliveries_webhook_id";--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
