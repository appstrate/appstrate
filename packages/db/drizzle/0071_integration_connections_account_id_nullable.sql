-- `integration_connections.account_id` becomes nullable: NULL = the provider
-- exposed no identity (replaces the 'default' sentinel). Metadata-only, no scan.
-- Run AFTER: `scripts/migration/0022-integration-connections-null-account-id.sql`
-- rewrites the existing 'default' rows; until then they read as an account
-- literally named 'default'.
-- ROLLBACK: UPDATE integration_connections SET account_id = 'default' WHERE
-- account_id IS NULL; then ALTER COLUMN "account_id" SET NOT NULL.
ALTER TABLE "integration_connections" ALTER COLUMN "account_id" DROP NOT NULL;
