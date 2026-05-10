-- Model Providers Unification — Phase 4/8
--
-- Drops the FK constraint on `org_models.provider_key_id` that pinned the
-- column to `org_system_provider_keys.id`. The column now holds either a
-- legacy `org_system_provider_keys` UUID (api-key path, until Phase 5) or a
-- `model_provider_credentials` UUID (new path, both auth modes).
--
-- The `loadModelProviderKeyCredentials` service does the polymorphic lookup
-- (new table first, legacy fallback) until Phase 5 retires the legacy table
-- and re-adds a strict FK to `model_provider_credentials.id`.

ALTER TABLE "org_models"
  DROP CONSTRAINT IF EXISTS "org_models_provider_key_id_org_system_provider_keys_id_fk";
