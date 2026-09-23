-- 0019 — revoke the credentials members removed BEFORE the leave-organization
-- release still hold in the organization they left.
--
-- Run ONCE, AFTER the release is deployed: the exit revokes these itself from
-- then on (`removeMemberInTx`), so this only repairs the rows it never saw.
-- `scripts/migration/README.md` → "Detail — Credentials of departed members".
--
-- ═══ WHAT IT REPAIRS ═══
--
-- Until this release a removal deleted the `org_members` row and left the
-- member's credentials in place. They were inert only because every reader
-- joins the membership — and they come back to life the moment the person is
-- re-invited:
--
--   1. `api_keys` — `validateApiKey` inner-joins `org_members` on the creator;
--   2. OAuth tokens of the organization's OWN clients (`oauth_clients.level =
--      'org'`) — a refresh through an `allowSignup` client even re-provisions
--      the membership (`buildOrgLevelClaims`);
--   3. OAuth tokens audience-bound to the organization's MCP resource
--      (`resources` ∋ `<APP_URL>/api/mcp/o/<org_id>`, `lib/audiences.ts`).
--
-- Only opaque tokens are rows: a JWT access token is not stored, and stays
-- valid until its TTL — the per-request membership check is what stops it.
--
-- ═══ WHAT IT DOES ═══
--
-- Sets `revoked_at` (keys) / `revoked` (tokens) to now(), ONLY where it is
-- NULL, on exactly the three sets above for a user who is NOT a member of the
-- organization the credential grants. A key whose creator was deleted
-- (`created_by` NULL) is left alone: it has no user to revive for.
--
-- Idempotent without a marker: the predicate is the condition the write
-- removes, so a second run captures nothing. One transaction, fenced. Only
-- `UPDATE`s. Irreversible in practice — a revoked credential is re-issued, not
-- restored. Not harmless to skip: a key or a token of a member's own
-- organization authenticates again the moment they are re-invited, and a
-- refresh through an `allowSignup` org client re-provisions the membership
-- today, without any invitation.
--
-- ═══ INVOCATION ═══
--
-- `app_url` is the platform's `APP_URL` EXACTLY as it runs (scheme, host,
-- port, no trailing slash) — the MCP resource URI is built from it:
--
--   docker exec -i <pg> psql -U appstrate -d appstrate -v ON_ERROR_STOP=1 \
--     -v app_url='https://app.appstrate.com' \
--     -f - < scripts/migration/0019-revoke-departed-members-credentials.sql
--
-- ═══ PRE-FLIGHT (read-only) ═══
--
-- The same three predicates as the views below (`mig0019_departed_*`), one row
-- per credential — the three counts the script prints as "before":
--
--   \set app_url 'https://app.appstrate.com'
--   WITH p AS (SELECT (:'app_url' || '/api/mcp/o/')::text AS mcp_prefix)
--   SELECT
--     (SELECT count(*) FROM api_keys k
--       WHERE k.revoked_at IS NULL AND k.created_by IS NOT NULL
--         AND NOT EXISTS (SELECT 1 FROM org_members m
--                          WHERE m.org_id = k.org_id AND m.user_id = k.created_by)
--     ) AS api_keys,
--     (SELECT count(*) FROM oauth_refresh_tokens t, p
--       WHERE t.revoked IS NULL AND (
--         EXISTS (SELECT 1 FROM oauth_clients c
--                  WHERE c.client_id = t.client_id AND c.level = 'org'
--                    AND NOT EXISTS (SELECT 1 FROM org_members m
--                                     WHERE m.org_id = c.referenced_org_id AND m.user_id = t.user_id))
--         OR EXISTS (SELECT 1 FROM unnest(t.resources) r(uri)
--                     WHERE left(r.uri, length(p.mcp_prefix)) = p.mcp_prefix
--                       AND substr(r.uri, length(p.mcp_prefix) + 1) ~ '^[0-9a-f-]{36}$'
--                       AND NOT EXISTS (SELECT 1 FROM org_members m
--                                        WHERE m.user_id = t.user_id
--                                          AND m.org_id::text = substr(r.uri, length(p.mcp_prefix) + 1))))
--     ) AS refresh_tokens,
--     (SELECT count(*) FROM oauth_access_tokens t, p
--       WHERE t.revoked IS NULL AND t.user_id IS NOT NULL AND (
--         EXISTS (SELECT 1 FROM oauth_clients c
--                  WHERE c.client_id = t.client_id AND c.level = 'org'
--                    AND NOT EXISTS (SELECT 1 FROM org_members m
--                                     WHERE m.org_id = c.referenced_org_id AND m.user_id = t.user_id))
--         OR EXISTS (SELECT 1 FROM unnest(t.resources) r(uri)
--                     WHERE left(r.uri, length(p.mcp_prefix)) = p.mcp_prefix
--                       AND substr(r.uri, length(p.mcp_prefix) + 1) ~ '^[0-9a-f-]{36}$'
--                       AND NOT EXISTS (SELECT 1 FROM org_members m
--                                        WHERE m.user_id = t.user_id
--                                          AND m.org_id::text = substr(r.uri, length(p.mcp_prefix) + 1))))
--     ) AS access_tokens;
--
-- Rows: UNMEASURED — not rehearsed against a restored dump. Do that first
-- (README requirement 4) and record the three counts the script prints.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- psql variables do not expand inside `DO $$ … $$`, so the prefix is captured
-- into a table the views and the checks read.
CREATE TEMP TABLE mig0019_params ON COMMIT DROP AS
  SELECT (:'app_url' || '/api/mcp/o/')::text AS mcp_prefix;

DO $$
DECLARE
  v_prefix text;
BEGIN
  SELECT mcp_prefix INTO v_prefix FROM mig0019_params;
  -- An empty or relative `app_url` would match no token and report success.
  IF v_prefix !~ '^https?://[^/]+/api/mcp/o/$' THEN
    RAISE EXCEPTION 'app_url must be the platform APP_URL (scheme://host[:port], no path, no trailing slash); got prefix %', v_prefix;
  END IF;
END $$;

-- ═══ 1. The departed-member predicates, stated once ═════════════════════════
--
-- Read before the writes (the capture) and after them (the end-state check).
-- A token is in scope when it grants an organization its user has left:
-- through an org-level client of that organization, or through a bound MCP
-- resource. The org id is taken off the URI only when the rest is a bare uuid —
-- the platform binds nothing else (`orgIdFromMcpAudience`).

CREATE TEMP VIEW mig0019_departed_keys AS
  SELECT k.id FROM api_keys k
  WHERE k.revoked_at IS NULL AND k.created_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM org_members m
                     WHERE m.org_id = k.org_id AND m.user_id = k.created_by);

CREATE TEMP VIEW mig0019_departed_refresh AS
  SELECT t.id FROM oauth_refresh_tokens t, mig0019_params p
  WHERE t.revoked IS NULL AND (
    EXISTS (SELECT 1 FROM oauth_clients c
             WHERE c.client_id = t.client_id AND c.level = 'org'
               AND NOT EXISTS (SELECT 1 FROM org_members m
                                WHERE m.org_id = c.referenced_org_id AND m.user_id = t.user_id))
    OR EXISTS (SELECT 1 FROM unnest(t.resources) r(uri)
                WHERE left(r.uri, length(p.mcp_prefix)) = p.mcp_prefix
                  AND substr(r.uri, length(p.mcp_prefix) + 1) ~ '^[0-9a-f-]{36}$'
                  AND NOT EXISTS (SELECT 1 FROM org_members m
                                   WHERE m.user_id = t.user_id
                                     AND m.org_id::text = substr(r.uri, length(p.mcp_prefix) + 1))));

CREATE TEMP VIEW mig0019_departed_access AS
  SELECT t.id FROM oauth_access_tokens t, mig0019_params p
  WHERE t.revoked IS NULL AND t.user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM oauth_clients c
             WHERE c.client_id = t.client_id AND c.level = 'org'
               AND NOT EXISTS (SELECT 1 FROM org_members m
                                WHERE m.org_id = c.referenced_org_id AND m.user_id = t.user_id))
    OR EXISTS (SELECT 1 FROM unnest(t.resources) r(uri)
                WHERE left(r.uri, length(p.mcp_prefix)) = p.mcp_prefix
                  AND substr(r.uri, length(p.mcp_prefix) + 1) ~ '^[0-9a-f-]{36}$'
                  AND NOT EXISTS (SELECT 1 FROM org_members m
                                   WHERE m.user_id = t.user_id
                                     AND m.org_id::text = substr(r.uri, length(p.mcp_prefix) + 1))));

-- ═══ 2. Before ══════════════════════════════════════════════════════════════

DO $$
BEGIN
  RAISE NOTICE 'before: % api key(s), % refresh token(s), % opaque access token(s) to revoke',
    (SELECT count(*) FROM mig0019_departed_keys),
    (SELECT count(*) FROM mig0019_departed_refresh),
    (SELECT count(*) FROM mig0019_departed_access);
END $$;

-- ═══ 3. Revoke ══════════════════════════════════════════════════════════════

UPDATE api_keys SET revoked_at = now()
WHERE id IN (SELECT id FROM mig0019_departed_keys);

UPDATE oauth_refresh_tokens SET revoked = now()
WHERE id IN (SELECT id FROM mig0019_departed_refresh);

UPDATE oauth_access_tokens SET revoked = now()
WHERE id IN (SELECT id FROM mig0019_departed_access);

-- ═══ 4. After — the end state, re-derived from the real tables ══════════════
--
-- The views re-run the capture predicates against the tables as they now
-- stand: any credential of a departed member still unrevoked fails the run.

DO $$
DECLARE
  v_keys bigint;
  v_refresh bigint;
  v_access bigint;
BEGIN
  SELECT count(*) INTO v_keys FROM mig0019_departed_keys;
  SELECT count(*) INTO v_refresh FROM mig0019_departed_refresh;
  SELECT count(*) INTO v_access FROM mig0019_departed_access;
  RAISE NOTICE 'after: % api key(s), % refresh token(s), % opaque access token(s) of departed members left unrevoked',
    v_keys, v_refresh, v_access;
  IF v_keys + v_refresh + v_access > 0 THEN
    RAISE EXCEPTION 'departed members still hold % unrevoked credential(s) — aborting',
      v_keys + v_refresh + v_access;
  END IF;
END $$;

-- Temp views are not ON COMMIT DROP; drop them before the table they read.
DROP VIEW mig0019_departed_keys, mig0019_departed_refresh, mig0019_departed_access;

COMMIT;
