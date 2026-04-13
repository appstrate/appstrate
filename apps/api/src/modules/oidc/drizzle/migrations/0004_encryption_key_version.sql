-- OIDC module: track encryption key version on per-app secret tables.
--
-- Stores the `CONNECTION_ENCRYPTION_KEY` version that was active when the
-- row's ciphertext was produced. The current runtime key version is derived
-- from the first 8 hex characters of a SHA-256 of the key bytes (see
-- @appstrate/connect). Rows encrypted with a previous key fail to decrypt
-- and surface as "SMTP configuration not found" / "social provider not
-- configured" at the resolver layer, preventing silent success on stale
-- ciphertext after a key rotation.
--
-- Rotation SOP (documented in `apps/api/src/modules/oidc/README.md`):
--   1. Rotate `CONNECTION_ENCRYPTION_KEY` (blue/green deploy).
--   2. Operators re-upsert every per-app SMTP + social row via the admin API.
--   3. The admin layer stamps the current version on write; the resolver
--      ignores rows with a mismatched version.

ALTER TABLE "application_smtp_configs"
  ADD COLUMN IF NOT EXISTS "encryption_key_version" text NOT NULL DEFAULT 'v1';

ALTER TABLE "application_social_providers"
  ADD COLUMN IF NOT EXISTS "encryption_key_version" text NOT NULL DEFAULT 'v1';
