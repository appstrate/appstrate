-- Rewrite the SPACE-DELIMITED `documents:*` permission scope strings to
-- `files:*` (issue #1177, phase 2c — the second half of 0044's data pass).
--
-- Migration 0043 renamed the tables; 0044 renamed the grant STRINGS stored in
-- the five credential columns shaped as `text[]`:
--
--   api_keys.scopes  oauth_clients.scopes  oauth_consents.scopes
--   oauth_refresh_tokens.scopes  oauth_access_tokens.scopes
--
-- Two platform credential columns store the very same scope vocabulary in a
-- DIFFERENT SHAPE — one `text` column holding a space-delimited scope string,
-- the OAuth 2.0 `scope` parameter as posted (RFC 6749 §3.3):
--
--   cli_refresh_tokens.scope  the set a rotated CLI access token is derived from
--   device_codes.scope        the set requested at `/device/code`, pending approval
--
-- 0044's `unnest(...)` / `array_agg(...)` pattern is array-shaped by
-- construction, so it could not reach them and did not: they were missed, not
-- excluded. This migration is that pass, and it needs its own SQL because a
-- space-delimited string has to be split into tokens first.
--
-- Why it matters, concretely. `narrowScopeToClient()` (oidc CLI token service)
-- intersects the scope string stored on the credential row with the `scopes`
-- array declared on the `oauth_clients` row. 0044 rewrote the CLIENT side. A
-- refresh token minted before the deploy still holds `documents:read`, so
-- without this pass the intersection compares `documents:read` against a client
-- that now declares `files:read`: the scope is DROPPED on rotation — no error,
-- no user-visible signal, just a `logger.warn` and a rotated JWT that quietly
-- lost file access. (The code side is now defended too: that function
-- canonicalizes both sides before intersecting, so a row minted between the
-- deploy and this migration still resolves. This migration removes the legacy
-- strings; the canonicalization makes their presence non-fatal in the window.)
--
-- ANCHORED PER TOKEN, never a bare `replace()`. Each value is split on
-- whitespace and a token is rewritten only when the WHOLE token starts with
-- `documents:` — a substring elsewhere (a client id, a third-party scope URL)
-- can never be corrupted.
--
-- NOT touched, deliberately — same list as 0044, restated so a future generic
-- rewrite does not sweep them up:
--   * `application_social_providers.scopes`,
--     `integration_connections.scopes_granted` and `account.scope` (Better
--     Auth's social-account rows — a third space-delimited `text` scope column,
--     in exactly this migration's shape) hold THIRD-PARTY provider scopes
--     (Google, GitHub, …), not Appstrate permissions.
--   * the read-time canonicalization, which stays.
--
-- And a hazard for whoever writes that future rewrite: anchor on the LEGACY
-- spelling, never on `files:`. Third-party integration manifests already
-- declare `files:read` / `files:write` verbatim — see the Slack `scope_catalog`
-- in `scripts/system-packages/integration-slack-1.0.2/manifest.json` — and
-- those manifests are persisted in `packages.draft_manifest` and
-- `package_versions.manifest`. A `files:`-anchored pass would corrupt them.
--
-- Idempotent + convergent: the `WHERE EXISTS` guard is the exact condition the
-- UPDATE removes (a token spelled `documents:*`), so a re-run touches zero rows
-- and a partially-applied environment converges. The `GROUP BY` collapses the
-- (possible) case where a value already carries BOTH spellings, which would
-- otherwise leave a duplicate token; `min(ord)` keeps the original request
-- order, which is the order the tokens are echoed back into the JWT `scope`
-- claim.
--
-- Two further side effects on the rows this UPDATE touches, both intentional
-- and both invisible to an RFC 6749 reader, which parses a scope string as a
-- set of space-delimited tokens (§3.3):
--   * DUPLICATE TOKENS COLLAPSE. `GROUP BY 1` is on the rewritten token, so a
--     value that already carried the same scope twice comes back carrying it
--     once. That is the same collapse 0044 gets from `array_agg(DISTINCT …)`.
--   * WHITESPACE NORMALIZES. `regexp_split_to_table(…, '\s+')` plus
--     `WHERE t <> ''` plus `string_agg(…, ' ')` means runs of whitespace become
--     a single space and leading/trailing whitespace is trimmed. A row NOT
--     matched by the guard keeps its original spacing byte for byte — only
--     rewritten rows are normalized.
--
-- The invariant this completes, stated precisely: after 0044 + 0045 no row in
-- the seven DEDICATED scope columns (`api_keys.scopes`, `oauth_clients.scopes`,
-- `oauth_consents.scopes`, `oauth_refresh_tokens.scopes`,
-- `oauth_access_tokens.scopes`, `cli_refresh_tokens.scope`,
-- `device_codes.scope`) contains a `documents:` scope, in either column shape.
--
-- It does NOT extend to scopes embedded in payload columns, and those are
-- deliberately left alone:
--   * `verification.value` — Better Auth's OAuth provider stores a pending
--     authorization code as `JSON.stringify({ type: "authorization_code",
--     query: {…scope…} })`. Rewriting inside that blob would mean parsing a
--     third-party JSON contract in SQL to fix a row that lives for one
--     authorization-code TTL (10 min by default). The exposure needs a mixed
--     -version fleet AND a code minted before the deploy, and it is not fatal
--     anyway: `/oauth2/authorize` is in `SCOPE_BEARING_PATHS`
--     (`apps/api/src/modules/oidc/auth/guards.ts`), so current code
--     canonicalizes the scope before the code is minted, and read-time
--     `canonicalPermissions()` still resolves anything older. Left as-is.
--   * `audit_events.after` — an append-only history of what a row LOOKED LIKE
--     at the time. Rewriting it would falsify the record it exists to keep.

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
