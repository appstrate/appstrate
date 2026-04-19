-- OIDC module: per-application social auth providers.
--
-- Composite PK (application_id, provider) — one row per (app, provider)
-- pair so a tenant can configure Google today and GitHub tomorrow
-- independently. When a row is absent, that provider's button is hidden
-- on the tenant's login/register pages for any `level=application` OAuth
-- client referencing the app. No fallback to instance env OAuth creds is
-- ever performed — shipping customer sign-ins through the platform's
-- Google OAuth App defeats the branding/audit/scope-control purpose this
-- table solves.
--
-- Client secret is AES-256-GCM encrypted at rest
-- (`encryptCredentials({ clientSecret })` in @appstrate/connect). Rotation
-- of `CONNECTION_ENCRYPTION_KEY` requires operators to re-upsert every
-- row via the admin API — `encryption_key_version` is stamped at write
-- time and the resolver treats rows with a stale version as "unconfigured"
-- (fails closed instead of decrypting with the wrong key).

CREATE TABLE IF NOT EXISTS "application_social_providers" (
  "application_id" text NOT NULL
    REFERENCES "applications"("id") ON DELETE CASCADE,
  "provider" text NOT NULL
    CONSTRAINT "application_social_providers_provider_check"
    CHECK ("provider" IN ('google', 'github')),
  "client_id" text NOT NULL,
  "client_secret_encrypted" text NOT NULL,
  "encryption_key_version" text NOT NULL DEFAULT 'v1',
  "scopes" text[],
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("application_id", "provider")
);
