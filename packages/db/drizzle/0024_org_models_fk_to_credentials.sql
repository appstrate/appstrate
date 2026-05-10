-- Reattach a strict FK from `org_models.provider_key_id` to the unified
-- `model_provider_credentials` table. ON DELETE RESTRICT prevents removing
-- a credential while any model still references it — the API surfaces the
-- error so the caller can detach the model first (no silent breakage).

ALTER TABLE "org_models"
  ADD CONSTRAINT "org_models_provider_key_id_fkey"
  FOREIGN KEY ("provider_key_id")
  REFERENCES "model_provider_credentials"("id")
  ON DELETE RESTRICT;
