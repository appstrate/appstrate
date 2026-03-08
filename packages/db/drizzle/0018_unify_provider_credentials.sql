-- Migration: Unify provider credentials
-- Eliminates provider_definitions and provider_configs tables.
-- Recreates provider_credentials keyed by (provider_id, org_id) instead of (config_hash, org_id).
-- Removes config_hash from service_connections.

-- 1. Drop old provider_credentials (keyed by config_hash)
DROP TABLE IF EXISTS "provider_credentials";

-- 2. Drop provider_configs (no longer needed — definition lives in packages.manifest)
DROP TABLE IF EXISTS "provider_configs";

-- 3. Drop provider_definitions (no longer needed — definition lives in packages.manifest)
DROP TABLE IF EXISTS "provider_definitions";

-- 4. Recreate provider_credentials keyed by (provider_id, org_id)
CREATE TABLE "provider_credentials" (
  "provider_id" text NOT NULL REFERENCES "packages"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "client_id_encrypted" text,
  "client_secret_encrypted" text,
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "provider_credentials_provider_id_org_id_pk" PRIMARY KEY ("provider_id", "org_id")
);

-- 5. Remove config_hash from service_connections if it exists
ALTER TABLE "service_connections" DROP COLUMN IF EXISTS "config_hash";

-- 6. Ensure unique index on service_connections is (profile_id, provider_id) only
DROP INDEX IF EXISTS "idx_service_connections_unique";
CREATE UNIQUE INDEX "idx_service_connections_unique" ON "service_connections" ("profile_id", "provider_id");
