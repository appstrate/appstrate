-- Migration: Replace hardcoded clientId/clientSecret columns with generic credentials_encrypted JSON blob
-- No production data exists — destructive column replacement is safe.

ALTER TABLE "provider_credentials" DROP COLUMN IF EXISTS "client_id_encrypted";
ALTER TABLE "provider_credentials" DROP COLUMN IF EXISTS "client_secret_encrypted";
ALTER TABLE "provider_credentials" ADD COLUMN "credentials_encrypted" text;
