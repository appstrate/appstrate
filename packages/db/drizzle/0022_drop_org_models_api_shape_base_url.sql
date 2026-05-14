-- Drop the redundant `api_shape` and `base_url` columns from `org_models`.
--
-- The credential's `providerId` (via `org_models.credential_id` →
-- `model_provider_credentials.provider_id`) is the single source of truth
-- for the API shape and the default base URL. Both are resolved from the
-- runtime registry (`apps/api/src/services/model-providers/registry.ts`)
-- at read time. `model_provider_credentials.base_url_override` carries
-- the per-credential override and is honored when the registered
-- `ModelProviderDefinition.baseUrlOverridable === true`
-- (today: `openai-compatible` only).
--
-- Migration is destructive — the dropped values are derivable from the
-- registry + credential row at any time, so no backfill is needed.
ALTER TABLE "org_models" DROP COLUMN IF EXISTS "api_shape";--> statement-breakpoint
ALTER TABLE "org_models" DROP COLUMN IF EXISTS "base_url";
