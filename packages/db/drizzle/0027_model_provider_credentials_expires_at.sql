-- Denormalize OAuth token expiry onto `model_provider_credentials`.
--
-- Before: the refresh worker scan (every 6h, cf.
-- `apps/api/src/services/oauth-model-providers/refresh-worker.ts`) had to
-- pull every row matching the OAuth `provider_id` allowlist and decrypt
-- each blob to test `expiresAt < now + 24h`. At 100K orgs × 2 OAuth
-- credentials, that is 200K envelope decrypts per sweep.
--
-- After: the scan filters at the SQL level via `expires_at IS NULL OR
-- expires_at < now() + interval '15 minutes'` (or the worker's lead
-- window) and only decrypts the qualifying subset. The encrypted blob
-- stays the source of truth — this column is a cache, kept in sync by
-- `createOAuthCredential` / `updateOAuthCredentialTokens` in
-- `apps/api/src/services/model-provider-credentials.ts`.
--
-- Backfill strategy: NULL for existing rows. The blob is encrypted with
-- an envelope (kid + AEAD) that can only be opened by the application,
-- so a SQL backfill is impossible. Rows expose themselves to the worker
-- via the `expires_at IS NULL` branch of the predicate; the next scan
-- decrypts them, calls `updateOAuthCredentialTokens` after the upstream
-- refresh, and the column becomes populated. Inefficient during the
-- first sweep post-deploy but auto-curing — no boot-time backfill needed.
ALTER TABLE "model_provider_credentials"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
--> statement-breakpoint

-- Partial index: only OAuth rows have a non-null `expires_at`. Keeps the
-- index footprint proportional to the OAuth row count, not the api-key
-- row count (which dominates on most installations).
CREATE INDEX IF NOT EXISTS "idx_model_provider_credentials_expires_at_oauth"
  ON "model_provider_credentials" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
