-- Migration: Providers as Packages
-- Creates provider_definitions + provider_credentials tables,
-- simplifies provider_configs (removes inline columns, adds config_hash FK),
-- removes auth_mode + provider_snapshot from service_connections,
-- adds "provider" to package_type enum.

-- 1. Add "provider" to package_type enum
ALTER TYPE "package_type" ADD VALUE IF NOT EXISTS 'provider';

-- 2. Create provider_definitions table (global, configHash PK)
CREATE TABLE IF NOT EXISTS "provider_definitions" (
  "config_hash" text PRIMARY KEY,
  "auth_mode" "auth_mode" NOT NULL,
  "authorization_url" text,
  "token_url" text,
  "refresh_url" text,
  "default_scopes" text[] DEFAULT '{}'::text[],
  "scope_separator" text DEFAULT ' ',
  "pkce_enabled" boolean DEFAULT true,
  "token_auth_method" text,
  "authorization_params" jsonb DEFAULT '{}'::jsonb,
  "token_params" jsonb DEFAULT '{}'::jsonb,
  "credential_schema" jsonb,
  "credential_field_name" text,
  "credential_header_name" text,
  "credential_header_prefix" text,
  "authorized_uris" text[] DEFAULT '{}'::text[],
  "allow_all_uris" boolean DEFAULT false,
  "request_token_url" text,
  "access_token_url" text,
  "available_scopes" jsonb DEFAULT '[]'::jsonb,
  "created_at" timestamp DEFAULT now()
);

-- 3. Create provider_credentials table (per-org secrets)
CREATE TABLE IF NOT EXISTS "provider_credentials" (
  "config_hash" text NOT NULL REFERENCES "provider_definitions"("config_hash"),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "client_id_encrypted" text,
  "client_secret_encrypted" text,
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "provider_credentials_config_hash_org_id_pk" PRIMARY KEY ("config_hash", "org_id")
);

-- 4. Migrate existing provider_configs data into provider_definitions + provider_credentials
-- For each existing provider_config row, compute a placeholder config_hash from its id+org_id
-- and insert the definition + credentials rows.
INSERT INTO "provider_definitions" (
  "config_hash", "auth_mode", "authorization_url", "token_url", "refresh_url",
  "default_scopes", "scope_separator", "pkce_enabled", "token_auth_method",
  "authorization_params", "token_params", "credential_schema", "credential_field_name",
  "credential_header_name", "credential_header_prefix", "authorized_uris", "allow_all_uris",
  "request_token_url", "access_token_url", "available_scopes", "created_at"
)
SELECT DISTINCT ON (md5(
  COALESCE(auth_mode::text, '') || '|' ||
  COALESCE(authorization_url, '') || '|' ||
  COALESCE(token_url, '') || '|' ||
  COALESCE(refresh_url, '') || '|' ||
  COALESCE(request_token_url, '') || '|' ||
  COALESCE(access_token_url, '') || '|' ||
  COALESCE(array_to_string(default_scopes, ','), '') || '|' ||
  COALESCE(scope_separator, ' ') || '|' ||
  COALESCE(pkce_enabled::text, 'true') || '|' ||
  COALESCE(token_auth_method, '') || '|' ||
  COALESCE(authorization_params::text, '{}') || '|' ||
  COALESCE(token_params::text, '{}') || '|' ||
  COALESCE(credential_schema::text, '') || '|' ||
  COALESCE(credential_field_name, '') || '|' ||
  COALESCE(credential_header_name, '') || '|' ||
  COALESCE(credential_header_prefix, '')
))
  md5(
    COALESCE(auth_mode::text, '') || '|' ||
    COALESCE(authorization_url, '') || '|' ||
    COALESCE(token_url, '') || '|' ||
    COALESCE(refresh_url, '') || '|' ||
    COALESCE(request_token_url, '') || '|' ||
    COALESCE(access_token_url, '') || '|' ||
    COALESCE(array_to_string(default_scopes, ','), '') || '|' ||
    COALESCE(scope_separator, ' ') || '|' ||
    COALESCE(pkce_enabled::text, 'true') || '|' ||
    COALESCE(token_auth_method, '') || '|' ||
    COALESCE(authorization_params::text, '{}') || '|' ||
    COALESCE(token_params::text, '{}') || '|' ||
    COALESCE(credential_schema::text, '') || '|' ||
    COALESCE(credential_field_name, '') || '|' ||
    COALESCE(credential_header_name, '') || '|' ||
    COALESCE(credential_header_prefix, '')
  ) as config_hash,
  auth_mode, authorization_url, token_url, refresh_url,
  COALESCE(default_scopes, '{}'::text[]),
  COALESCE(scope_separator, ' '),
  COALESCE(pkce_enabled, true),
  token_auth_method,
  COALESCE(authorization_params, '{}'::jsonb),
  COALESCE(token_params, '{}'::jsonb),
  credential_schema,
  credential_field_name,
  credential_header_name,
  credential_header_prefix,
  COALESCE(authorized_uris, '{}'::text[]),
  COALESCE(allow_all_uris, false),
  request_token_url,
  access_token_url,
  COALESCE(available_scopes, '[]'::jsonb),
  created_at
FROM "provider_configs"
ON CONFLICT ("config_hash") DO NOTHING;

-- Insert provider_credentials from existing provider_configs (per org)
INSERT INTO "provider_credentials" ("config_hash", "org_id", "client_id_encrypted", "client_secret_encrypted", "updated_at")
SELECT
  md5(
    COALESCE(auth_mode::text, '') || '|' ||
    COALESCE(authorization_url, '') || '|' ||
    COALESCE(token_url, '') || '|' ||
    COALESCE(refresh_url, '') || '|' ||
    COALESCE(request_token_url, '') || '|' ||
    COALESCE(access_token_url, '') || '|' ||
    COALESCE(array_to_string(default_scopes, ','), '') || '|' ||
    COALESCE(scope_separator, ' ') || '|' ||
    COALESCE(pkce_enabled::text, 'true') || '|' ||
    COALESCE(token_auth_method, '') || '|' ||
    COALESCE(authorization_params::text, '{}') || '|' ||
    COALESCE(token_params::text, '{}') || '|' ||
    COALESCE(credential_schema::text, '') || '|' ||
    COALESCE(credential_field_name, '') || '|' ||
    COALESCE(credential_header_name, '') || '|' ||
    COALESCE(credential_header_prefix, '')
  ),
  org_id,
  client_id_encrypted,
  client_secret_encrypted,
  updated_at
FROM "provider_configs"
ON CONFLICT ("config_hash", "org_id") DO NOTHING;

-- 5. Add config_hash column to provider_configs (before dropping old columns)
ALTER TABLE "provider_configs" ADD COLUMN IF NOT EXISTS "config_hash_new" text;

-- Populate config_hash_new from existing data
UPDATE "provider_configs" SET "config_hash_new" = md5(
  COALESCE(auth_mode::text, '') || '|' ||
  COALESCE(authorization_url, '') || '|' ||
  COALESCE(token_url, '') || '|' ||
  COALESCE(refresh_url, '') || '|' ||
  COALESCE(request_token_url, '') || '|' ||
  COALESCE(access_token_url, '') || '|' ||
  COALESCE(array_to_string(default_scopes, ','), '') || '|' ||
  COALESCE(scope_separator, ' ') || '|' ||
  COALESCE(pkce_enabled::text, 'true') || '|' ||
  COALESCE(token_auth_method, '') || '|' ||
  COALESCE(authorization_params::text, '{}') || '|' ||
  COALESCE(token_params::text, '{}') || '|' ||
  COALESCE(credential_schema::text, '') || '|' ||
  COALESCE(credential_field_name, '') || '|' ||
  COALESCE(credential_header_name, '') || '|' ||
  COALESCE(credential_header_prefix, '')
);

-- 6. Drop old columns from provider_configs
ALTER TABLE "provider_configs"
  DROP COLUMN IF EXISTS "auth_mode",
  DROP COLUMN IF EXISTS "display_name",
  DROP COLUMN IF EXISTS "client_id_encrypted",
  DROP COLUMN IF EXISTS "client_secret_encrypted",
  DROP COLUMN IF EXISTS "authorization_url",
  DROP COLUMN IF EXISTS "token_url",
  DROP COLUMN IF EXISTS "refresh_url",
  DROP COLUMN IF EXISTS "default_scopes",
  DROP COLUMN IF EXISTS "scope_separator",
  DROP COLUMN IF EXISTS "pkce_enabled",
  DROP COLUMN IF EXISTS "token_auth_method",
  DROP COLUMN IF EXISTS "authorization_params",
  DROP COLUMN IF EXISTS "token_params",
  DROP COLUMN IF EXISTS "credential_schema",
  DROP COLUMN IF EXISTS "credential_field_name",
  DROP COLUMN IF EXISTS "credential_header_name",
  DROP COLUMN IF EXISTS "credential_header_prefix",
  DROP COLUMN IF EXISTS "available_scopes",
  DROP COLUMN IF EXISTS "authorized_uris",
  DROP COLUMN IF EXISTS "allow_all_uris",
  DROP COLUMN IF EXISTS "request_token_url",
  DROP COLUMN IF EXISTS "access_token_url",
  DROP COLUMN IF EXISTS "icon_url",
  DROP COLUMN IF EXISTS "categories",
  DROP COLUMN IF EXISTS "docs_url";

-- Rename config_hash_new to config_hash
ALTER TABLE "provider_configs" RENAME COLUMN "config_hash_new" TO "config_hash";
ALTER TABLE "provider_configs" ALTER COLUMN "config_hash" SET NOT NULL;
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_config_hash_fk"
  FOREIGN KEY ("config_hash") REFERENCES "provider_definitions"("config_hash");

-- 7. Update service_connections: make auth_mode and provider_snapshot nullable, then drop
-- First update existing service_connections config_hash values that used the old format
ALTER TABLE "service_connections" DROP COLUMN IF EXISTS "auth_mode";
ALTER TABLE "service_connections" DROP COLUMN IF EXISTS "provider_snapshot";
