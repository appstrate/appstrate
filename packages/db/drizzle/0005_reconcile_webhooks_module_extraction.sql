-- Reconcile drizzle-kit snapshot after webhooks were extracted into the
-- webhooks module (apps/api/src/modules/webhooks). The `webhooks` and
-- `webhook_deliveries` tables are now owned and migrated by the module via
-- `__drizzle_migrations_webhooks`. The module migration uses
-- CREATE TABLE IF NOT EXISTS, so existing rows from core migration 0000 are
-- preserved. This no-op migration exists only to update the core drizzle-kit
-- snapshot so that future `bun run db:generate` runs don't emit a spurious
-- DROP TABLE against the webhook tables.
SELECT 1;
