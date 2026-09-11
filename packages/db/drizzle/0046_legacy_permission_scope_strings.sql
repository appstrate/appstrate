-- Rewrite the persisted `documents:*` permission scope strings to `files:*`
-- (issue #1177 — the data half of the permission-resource rename, restored).
--
-- ═══ WHY THIS FILE EXISTS AT NUMBER 0046 ═══
--
-- Two earlier migrations did this work: `0044_documents_scope_strings` (the
-- five `text[]` columns) and `0045_documents_scope_delimited_strings` (the two
-- space-delimited `text` ones). Both were deleted when the physical-layer
-- rename took their numbers, on the stated grounds that they merely
-- COMPLEMENTED a read-time canonicalization — and that reasoning was sound only
-- for as long as the canonicalization existed. It does not: the commit that
-- removed `LEGACY_PERMISSION_RESOURCE_ALIASES` / `canonicalPermissions()` cited
-- these two migrations as the reason the read alias was redundant, and the
-- commit that deleted these two migrations cited the removed alias as the
-- reason they were redundant. Each is fine alone; together they left a database
-- upgraded from `v1.0.0-beta.51` with NEITHER half.
--
-- The failure that leaves is silent, which is why it is worth a migration
-- number of its own. `resolveApiKeyPermissions` (`apps/api/src/lib/permissions.ts`)
-- intersects a key's stored scope set with its creator's role permissions and
-- drops every string it does not recognise. A key issued as `documents:read`
-- keeps authenticating and simply grants less than it was issued with — no
-- error, no rejection, no user-visible signal. `narrowScopeToClient`
-- (`modules/oidc/services/cli-tokens.ts`) does the same on every CLI refresh
-- rotation, and `scopesToPermissions` (`modules/oidc/auth/claims.ts`) does it
-- for a live bearer token. Silent under-granting is exactly the failure class
-- the surrounding work exists to remove.
--
-- This migration restores the DATA rewrite and only that. The read path stays
-- canonical-only by design: an OAuth client that still SENDS `documents:read`
-- is refused with `invalid_scope` at `/oauth2/authorize`, which is a loud
-- failure and the intended one. Nothing here re-introduces an alias.
--
-- ═══ THE SEVEN COLUMNS, IN TWO SHAPES ═══
--
-- A permission scope is not only a vocabulary — it is a value persisted inside
-- every credential that was ever issued. Five columns hold it as `text[]`:
--
--   api_keys.scopes             a key's granted scope set
--   oauth_clients.scopes        a registered OIDC client's requestable set
--   oauth_consents.scopes       a user's standing grant to a client
--   oauth_refresh_tokens.scopes the set a refreshed access token is derived from
--   oauth_access_tokens.scopes  the live bearer token's set
--
-- Two hold the SAME vocabulary as a space-delimited `text` string — the OAuth
-- 2.0 `scope` parameter as posted (RFC 6749 §3.3):
--
--   cli_refresh_tokens.scope    the set a rotated CLI access token is derived from
--   device_codes.scope          the set requested at `/device/code`, pending approval
--
-- The `unnest(...)` pattern below is array-shaped by construction and cannot
-- reach the second shape, which is why the two passes are written separately in
-- one file rather than merged into one clever statement.
--
-- ═══ ANCHORED, NEVER A BARE replace() ═══
--
-- Array shape: the `CASE` fires only on `s LIKE 'documents:%'`, i.e. the whole
-- element starts with the legacy resource. Delimited shape: each value is split
-- on whitespace first and a TOKEN is rewritten only when the whole token starts
-- with `documents:`. A `documents:` substring elsewhere — inside a client id, a
-- third-party scope URL, a scope spelled `mydocuments:read` — can never be
-- corrupted.
--
-- NOT touched, deliberately, and restated here so a future generic rewrite does
-- not sweep them up:
--   * `application_social_providers.scopes`,
--     `integration_connections.scopes_granted` and `account.scope` (Better
--     Auth's social-account rows, a third space-delimited `text` scope column
--     in exactly this migration's second shape) hold THIRD-PARTY provider
--     scopes (Google, GitHub, …), not Appstrate permissions.
--   * `verification.value` — Better Auth stores a pending authorization code as
--     `JSON.stringify({ type: "authorization_code", query: {…scope…} })`.
--     Rewriting inside that blob means parsing a third-party JSON contract in
--     SQL to fix a row that lives for one authorization-code TTL (10 min).
--   * `audit_events.after` — an append-only record of what a row LOOKED LIKE at
--     the time. Rewriting it would falsify the history it exists to keep.
--
-- And the hazard for whoever writes the next rewrite: anchor on the LEGACY
-- spelling, never on `files:`. Third-party integration manifests declare
-- `files:read` / `files:write` verbatim — see the Slack `scope_catalog` in
-- `scripts/system-packages/integration-slack-1.0.2/manifest.json` — and those
-- manifests are persisted in `packages.draft_manifest` and
-- `package_versions.manifest`. A `files:`-anchored pass would corrupt them.
--
-- ═══ IDEMPOTENCY ═══
--
-- Every `WHERE` clause is the exact condition its `UPDATE` removes, so a re-run
-- touches zero rows and a partially-applied environment converges — including a
-- database that already applied the deleted `0044`/`0045`, where every statement
-- here is a no-op. `array_agg(DISTINCT …)` and `GROUP BY 1` collapse the case
-- where one value carries BOTH spellings, which would otherwise leave a
-- duplicate.
--
-- Two further side effects on delimited rows this UPDATE touches, both
-- intentional and both invisible to an RFC 6749 §3.3 reader (which parses a
-- scope string as a SET of space-delimited tokens):
--   * DUPLICATE TOKENS COLLAPSE, the same collapse `array_agg(DISTINCT …)` gets.
--   * WHITESPACE NORMALIZES — `regexp_split_to_table(…, '\s+')` plus
--     `WHERE t <> ''` plus `string_agg(…, ' ')` turns runs of whitespace into a
--     single space and trims the ends. A row NOT matched by the guard keeps its
--     original spacing byte for byte; only rewritten rows are normalized.
--   * `min(ord)` keeps the original request order, which is the order the
--     tokens are echoed back into the JWT `scope` claim.

-- ── Shape 1: the five `text[]` credential columns ────────────────────────────

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
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'documents:%');--> statement-breakpoint

-- ── Shape 2: the two space-delimited `text` scope columns ────────────────────

UPDATE "cli_refresh_tokens"
SET "scope" = (
  SELECT string_agg(d.tok, ' ' ORDER BY d.pos)
  FROM (
    SELECT
      CASE WHEN t LIKE 'documents:%' THEN 'files:' || substring(t FROM 11) ELSE t END AS tok,
      min(ord) AS pos
    FROM regexp_split_to_table("scope", '\s+') WITH ORDINALITY AS x(t, ord)
    WHERE t <> ''
    GROUP BY 1
  ) d
)
WHERE "scope" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM regexp_split_to_table("scope", '\s+') AS t
    WHERE t LIKE 'documents:%'
  );--> statement-breakpoint

UPDATE "device_codes"
SET "scope" = (
  SELECT string_agg(d.tok, ' ' ORDER BY d.pos)
  FROM (
    SELECT
      CASE WHEN t LIKE 'documents:%' THEN 'files:' || substring(t FROM 11) ELSE t END AS tok,
      min(ord) AS pos
    FROM regexp_split_to_table("scope", '\s+') WITH ORDINALITY AS x(t, ord)
    WHERE t <> ''
    GROUP BY 1
  ) d
)
WHERE "scope" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM regexp_split_to_table("scope", '\s+') AS t
    WHERE t LIKE 'documents:%'
  );
