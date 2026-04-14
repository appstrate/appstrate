-- OIDC module: per-application SMTP configuration.
--
-- Row keyed on application_id (PK + FK, ON DELETE CASCADE). When absent,
-- email features (verification, magic-link, reset-password) are disabled
-- for OIDC flows driven by any `level=application` client referencing that
-- application. No fallback to instance-level env SMTP is ever performed —
-- mixing tenant email traffic through a shared transport is the exact
-- deliverability/DKIM/branding problem this table solves.
--
-- Password is AES-256-GCM encrypted at rest (`encryptCredentials({ pass })`
-- in @appstrate/connect). Rotation of `CONNECTION_ENCRYPTION_KEY` requires
-- operators to re-upsert every row via the admin API — `encryption_key_version`
-- is stamped at write time and the resolver treats rows with a stale version
-- as "unconfigured" (fails closed instead of decrypting with the wrong key).

CREATE TABLE IF NOT EXISTS "application_smtp_configs" (
  "application_id" text PRIMARY KEY
    REFERENCES "applications"("id") ON DELETE CASCADE,
  "host" text NOT NULL,
  "port" integer NOT NULL,
  "username" text NOT NULL,
  "pass_encrypted" text NOT NULL,
  "encryption_key_version" text NOT NULL DEFAULT 'v1',
  "from_address" text NOT NULL,
  "from_name" text,
  "secure_mode" text NOT NULL DEFAULT 'auto'
    CONSTRAINT "application_smtp_configs_secure_mode_check"
    CHECK ("secure_mode" IN ('auto', 'tls', 'starttls', 'none')),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
