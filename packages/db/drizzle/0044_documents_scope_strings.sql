-- Rewrite the stored `documents:*` permission scope strings to `files:*`
-- (issue #1177, phase 2b — the data half of the permission-resource rename).
--
-- Migration 0043 renamed the TABLES. This one renames the grant STRINGS that
-- name the permission resource, because a permission scope is not only a
-- vocabulary — it is a value persisted inside every credential that was ever
-- issued:
--
--   api_keys.scopes             a key's granted scope set
--   oauth_clients.scopes        a registered OIDC client's requestable set
--   oauth_consents.scopes       a user's standing grant to a client
--   oauth_refresh_tokens.scopes the set a refreshed access token is derived from
--   oauth_access_tokens.scopes  the live bearer token's set
--
-- Every read path already canonicalizes (`canonicalPermissions()` in
-- `@appstrate/core/permissions`, wired into `resolveApiKeyPermissions`,
-- `validateScopes`, `scopesToPermissions` and `assertValidScopes`), so nothing
-- breaks WITHOUT this migration. It runs anyway for three reasons:
--
--   1. Read-time normalization is a translation layer that has to be applied at
--      every site, forever. Each new site that forgets it degrades SILENTLY —
--      the scope is not rejected, it is dropped, and the credential merely does
--      less than it was granted. Removing the stored legacy strings turns that
--      class of bug from "silent under-grant" into "cannot happen".
--   2. The scope sets are user-visible (the API-key UI, the OIDC consent
--      screen). A key created in 2025 would otherwise keep displaying a
--      resource name that exists nowhere else in the product.
--   3. It makes the invariant checkable: after this migration no row in any of
--      the five ARRAY-shaped credential columns above contains a `documents:`
--      scope.
--
-- The invariant stops at the column SHAPE. Two platform credential columns
-- store the same scope vocabulary as a space-delimited `text` string
-- (`cli_refresh_tokens.scope`, `device_codes.scope`); the `unnest(...)` pattern
-- below is array-shaped by construction and cannot reach them. Migration 0045
-- is that pass — only WITH it does "no row in any credential table contains a
-- `documents:` scope" hold in full.
--
-- NOT touched, deliberately:
--   * `application_social_providers.scopes`,
--     `integration_connections.scopes_granted` and `account.scope` (Better
--     Auth's social-account rows) hold THIRD-PARTY provider scopes (Google,
--     GitHub, …), not Appstrate permissions. The `documents:` prefix anchor
--     cannot match them, and they are excluded here in writing so a future
--     generic rewrite does not sweep them up.
--   * the read-time canonicalization, which stays: a token minted before this
--     migration ran, or by a replica still on the old code, must keep working.
--
-- And a hazard for whoever writes that future rewrite: anchor on the LEGACY
-- spelling, never on `files:`. Third-party integration manifests already
-- declare `files:read` / `files:write` verbatim — see the Slack `scope_catalog`
-- in `scripts/system-packages/integration-slack-1.0.2/manifest.json` — and
-- those manifests are persisted in `packages.draft_manifest` and
-- `package_versions.manifest`. A `files:`-anchored pass would corrupt them.
--
-- Idempotent + convergent: the WHERE clause is the exact condition the UPDATE
-- removes, so a re-run is a no-op and a partially-applied environment
-- converges. `array_agg(DISTINCT …)` collapses the (possible) case where a row
-- already carries BOTH spellings, which would otherwise leave a duplicate.

UPDATE "api_keys"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'documents:%' THEN 'files:' || substring(s FROM 11)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'documents:%');--> statement-breakpoint

UPDATE "oauth_clients"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'documents:%' THEN 'files:' || substring(s FROM 11)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'documents:%');--> statement-breakpoint

UPDATE "oauth_consents"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'documents:%' THEN 'files:' || substring(s FROM 11)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'documents:%');--> statement-breakpoint

UPDATE "oauth_refresh_tokens"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'documents:%' THEN 'files:' || substring(s FROM 11)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'documents:%');--> statement-breakpoint

UPDATE "oauth_access_tokens"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'documents:%' THEN 'files:' || substring(s FROM 11)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'documents:%');
