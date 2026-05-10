-- Phase 5 of the unified model-provider-credentials migration.
--
-- The legacy `org_system_provider_keys` table is fully retired now that
-- both API-key and OAuth credential paths land in `model_provider_credentials`
-- (Phase 4 moved OAuth, this commit moves API-key writes). Any rows still
-- present in the legacy table are abandoned — no automated copy because
-- (a) we have no production data yet and (b) the new table requires a
-- canonical `providerId` that the legacy `(api, base_url)` pair cannot
-- always disambiguate.

DROP TABLE IF EXISTS "org_system_provider_keys";
