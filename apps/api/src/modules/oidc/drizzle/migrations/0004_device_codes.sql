-- OIDC module: RFC 8628 Device Authorization Grant.
--
-- Backs Better Auth's `deviceAuthorization()` plugin (mounted by the OIDC
-- module's `betterAuthPlugins()`). One row per in-flight or approved
-- device code issued by `POST /api/auth/device/code`. Row lifetime:
-- `status = 'pending'` at creation → 'approved' or 'denied' when the user
-- acts on `/activate` → deleted by `/api/auth/device/token` after minting
-- the BA session, or by `/api/auth/device/token` after detecting expiry
-- (both inside the plugin's own routes, we don't have to sweep manually).
--
-- Audience / realm enforcement lives in `oidcGuardsPlugin.hooks.before`
-- on `/device/approve` — the BA plugin does NOT consult `oauth_clients`
-- metadata, so the platform-realm check for instance-level CLI clients
-- must be injected via the guard plugin, mirroring the same pattern used
-- for `/oauth2/token` / `/oauth2/authorize` / etc. See `auth/guards.ts`.

CREATE TABLE IF NOT EXISTS "device_codes" (
  "id" text PRIMARY KEY,
  "device_code" text NOT NULL UNIQUE,
  "user_code" text NOT NULL UNIQUE,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "expires_at" timestamp NOT NULL,
  "status" text NOT NULL,
  "last_polled_at" timestamp,
  "polling_interval" integer,
  "client_id" text REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE,
  "scope" text
);

-- Intentionally no extra indexes. The UNIQUE constraints on
-- `device_code` / `user_code` already create B-trees for the only
-- equality lookups this table supports; `client_id` is never a query
-- predicate; expiry is checked inline on the single row fetched by
-- user_code. Pending codes are few (seconds-to-minutes TTL) so a
-- seq-scan on FK cascade delete is cheap.
