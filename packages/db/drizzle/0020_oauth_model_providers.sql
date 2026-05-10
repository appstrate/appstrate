-- OAuth Model Providers — Phase 3.1
--
-- Extends `org_system_provider_keys` to support OAuth-subscription billing
-- (ChatGPT Plus/Pro for Codex, Claude Pro/Max for Claude Code) in addition
-- to the existing API-key auth mode.
--
-- Spec: docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §2.1
--
-- Changes:
--   1. `api_key_encrypted` becomes nullable (filled when auth_mode='api_key',
--      NULL when auth_mode='oauth').
--   2. New `auth_mode` column (default 'api_key' — no data migration needed,
--      existing rows satisfy the new CHECK constraint immediately).
--   3. New `oauth_connection_id` FK → `user_provider_connections.id` with
--      ON DELETE CASCADE (deleting the connection drops the model provider
--      config to keep the CHECK constraint consistent).
--   4. New `provider_package_id` text column (e.g. '@appstrate/provider-codex')
--      — soft FK by convention, no DB-level constraint (registry packages
--      may not all be loaded at boot).
--   5. CHECK constraint enforcing exactly-one-mode invariant.
--   6. Index on `oauth_connection_id` for the BullMQ refresh worker scan.
--
-- Idempotent shape via `IF EXISTS` / `IF NOT EXISTS` — safe for partial reapply.

ALTER TABLE "org_system_provider_keys"
  ALTER COLUMN "api_key_encrypted" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "org_system_provider_keys"
  ADD COLUMN IF NOT EXISTS "auth_mode" text NOT NULL DEFAULT 'api_key';
--> statement-breakpoint

ALTER TABLE "org_system_provider_keys"
  ADD COLUMN IF NOT EXISTS "oauth_connection_id" uuid;
--> statement-breakpoint

ALTER TABLE "org_system_provider_keys"
  ADD COLUMN IF NOT EXISTS "provider_package_id" text;
--> statement-breakpoint

ALTER TABLE "org_system_provider_keys"
  DROP CONSTRAINT IF EXISTS "org_system_provider_keys_oauth_connection_id_user_provider_connections_id_fk";
--> statement-breakpoint

ALTER TABLE "org_system_provider_keys"
  ADD CONSTRAINT "org_system_provider_keys_oauth_connection_id_user_provider_connections_id_fk"
  FOREIGN KEY ("oauth_connection_id")
  REFERENCES "user_provider_connections"("id")
  ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "org_system_provider_keys"
  DROP CONSTRAINT IF EXISTS "org_system_provider_keys_auth_mode_consistency";
--> statement-breakpoint

ALTER TABLE "org_system_provider_keys"
  ADD CONSTRAINT "org_system_provider_keys_auth_mode_consistency"
  CHECK (
    (auth_mode = 'api_key' AND api_key_encrypted IS NOT NULL AND oauth_connection_id IS NULL) OR
    (auth_mode = 'oauth'   AND api_key_encrypted IS NULL     AND oauth_connection_id IS NOT NULL)
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_org_system_provider_keys_oauth_conn"
  ON "org_system_provider_keys" ("oauth_connection_id");
