-- Replace `webhook_deliveries (webhook_id)` with `(webhook_id, created_at, id)`.
--
-- WHY. `GET /api/webhooks/{id}/deliveries` is keyset-paginated
-- (`apps/api/src/modules/webhooks/service.ts` → `listDeliveries`):
--
--   WHERE webhook_id = ? [AND (created_at, id) < (cursor row)]
--   ORDER BY created_at DESC, id DESC LIMIT n + 1
--
-- The single-column index serves the filter only, so every page read the
-- webhook's WHOLE history and sorted it to return twenty rows. With the
-- composite the filter is a seek, the row-value bound a range start, and the
-- DESC order a backward walk: a page costs its own size.
--
-- WHY THE OLD INDEX GOES. Every other read of the table leads with
-- `webhook_id` and needs nothing after it: the cursor lookup
-- (`webhook_id = ? AND id = ?`, served by the primary key anyway) and the
-- `ON DELETE CASCADE` from `webhooks`, which finds a webhook's deliveries by
-- `webhook_id`. The composite's leading column serves both, so the narrower
-- index is pure write cost on the delivery worker's insert path.
--
-- LOCK AND COST. Plain `CREATE INDEX` (never CONCURRENTLY — Postgres forbids it
-- inside a transaction block and drizzle wraps the pending batch in one; see
-- 0041's header) takes SHARE on `webhook_deliveries`, blocking delivery-row
-- INSERTs until the batch commits; `DROP INDEX` takes ACCESS EXCLUSIVE, only
-- for the catalog update. Same two fences as 0050/0052 (`SET LOCAL`, reset
-- after): `lock_timeout` bounds acquisition, `statement_timeout` the build.
-- The table has no retention policy, so the build is as large as the history.
-- On expiry the batch aborts and the deploy fails its health gate: retry.
--
-- `IF [NOT] EXISTS` so a partially-applied environment converges.
--
-- ROLLBACK: `CREATE INDEX "idx_webhook_deliveries_webhook_id" ON
-- "webhook_deliveries" ("webhook_id"); DROP INDEX
-- "idx_webhook_deliveries_webhook_created";`.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook_created" ON "webhook_deliveries" USING btree ("webhook_id","created_at","id");--> statement-breakpoint
DROP INDEX IF EXISTS "idx_webhook_deliveries_webhook_id";--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
