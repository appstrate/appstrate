# Migration 0023 — Legacy `org_system_provider_keys` removal

This migration drops the pre-OAuth-refactor table `org_system_provider_keys`. The new unified surface is `model_provider_credentials`.

## Who is affected

Self-hosters who deployed Appstrate **before migration 0021** and stored API-key credentials for system model providers (OpenAI, Anthropic, OpenRouter, custom OpenAI-compatible endpoints) through the old admin UI.

If you've never set up system model providers, or if your install is post-0021, this migration is a no-op.

## Why no auto-copy

The legacy schema stored `(api, base_url, api_key_encrypted)`. The new schema requires a canonical `providerId` enum (`openai`, `anthropic`, `claude-code`, `codex`, `openai-compatible`, …). The `(api, base_url)` pair does not always disambiguate — `openai-compatible` shape may legitimately map to a dozen different `providerId` values depending on what's running behind the URL.

Silent mis-mapping would produce credentials that decrypt fine but route requests to the wrong upstream. The migration therefore fails loudly when it detects unmigrated rows so the operator can take an explicit decision.

## Manual migration steps

1. **Before running migrations**, capture the legacy rows:

   ```sh
   psql "$DATABASE_URL" -c "SELECT id, label, api, base_url FROM org_system_provider_keys;"
   ```

2. **Boot the new build** with the migration paused (or accept the boot failure once and proceed). For each row in the listing, recreate the credential under the new admin surface — Settings → Model Providers → Add API Key. Pick the canonical `providerId` that matches the upstream you were pointing at.

3. **Truncate the legacy table** once every row is recreated:

   ```sh
   psql "$DATABASE_URL" -c "DELETE FROM org_system_provider_keys;"
   ```

4. **Re-run migrations**:

   ```sh
   bun run db:migrate
   ```

   Migration 0023 now sees an empty legacy table, drops it, and the deployment proceeds.

## What if I lose the API keys?

The `api_key_encrypted` column is encrypted with `CONNECTION_ENCRYPTION_KEY`. If you have the key, you can decrypt the values yourself before recreating them in the UI:

```sh
# Pseudocode — adapt to your tooling
SELECT pgp_sym_decrypt(api_key_encrypted, '$CONNECTION_ENCRYPTION_KEY') FROM org_system_provider_keys;
```

(Appstrate uses an envelope format — see `@appstrate/connect`'s `decryptCredentials` for the exact decode path.)

If you've lost the encryption key, you'll need to re-issue the API keys at the upstream provider — there's no way to recover the plaintext.
