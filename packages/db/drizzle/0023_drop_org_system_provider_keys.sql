-- Phase 5 of the unified model-provider-credentials migration.
--
-- The legacy `org_system_provider_keys` table is fully retired now that
-- both API-key and OAuth credential paths land in `model_provider_credentials`
-- (Phase 4 moved OAuth, this commit moves API-key writes).
--
-- Self-host upgrade safety: an automated copy is risky because the new
-- table requires a canonical `providerId` that the legacy `(api, base_url)`
-- pair cannot always disambiguate (e.g. `openai-compatible` shape may map
-- to `openai`, `togetherai`, a custom proxy, …). Rather than silently
-- losing rows OR silently mis-mapping them, we fail loudly and force the
-- operator to migrate manually — they have full context on which legacy
-- entries map to which canonical provider.
--
-- Action for affected operators: see docs/migrations/0023-legacy-keys.md
-- (TL;DR — re-create each entry through the UI, then re-run migrations).
DO $$
DECLARE
  legacy_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'org_system_provider_keys'
  ) THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT COUNT(*) FROM org_system_provider_keys' INTO legacy_count;
  IF legacy_count > 0 THEN
    RAISE EXCEPTION
      'Found % row(s) in legacy "org_system_provider_keys" — refusing to drop. Recreate each credential under the new model_provider_credentials surface, then DELETE FROM org_system_provider_keys; before re-running this migration. (See docs/migrations/0023-legacy-keys.md)',
      legacy_count;
  END IF;
END $$;

DROP TABLE IF EXISTS "org_system_provider_keys";
