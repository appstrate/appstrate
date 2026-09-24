-- 0026 — rename every camelCase top-level key of
-- `integration_connections.identity_claims` to its snake_case form (#1545 D10):
-- `accountId` → `account_id`, `avatarUrl` → `avatar_url`, `teamName` →
-- `team_name`, … Generic, not a name list: a key is rewritten iff it holds a
-- lower-or-digit → upper transition, as `lower(regexp_replace(k,
-- '([a-z0-9])([A-Z])', '\1_\2'))`. `sub`, `email`, `picture`, snake keys and
-- keys with no such transition are untouched; values never change. When a
-- row holds both spellings, the one already snake_case wins.
-- The bag is display data returned verbatim on the wire (the one key read off
-- it, `/api/me/connections`' `account_email`, only picks a label), so run it
-- once AFTER deploying the release whose system manifests declare snake_case
-- keys: the old build keeps writing camelCase ones until it stops. The
-- `account_id` column is not touched.
-- Cost: UPDATEs only the rows still holding a camelCase key; idempotent.
-- Rows: UNMEASURED — rehearse on a restored dump first (README requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % connection(s) to rewrite, % holding both spellings of a key',
    (SELECT count(*) FROM integration_connections
      WHERE jsonb_typeof(identity_claims) = 'object'
        AND EXISTS (SELECT 1 FROM jsonb_object_keys(identity_claims) AS k
                    WHERE k ~ '[a-z0-9][A-Z]')),
    (SELECT count(*) FROM integration_connections
      WHERE jsonb_typeof(identity_claims) = 'object'
        AND EXISTS (SELECT 1 FROM jsonb_object_keys(identity_claims) AS k
                    WHERE k ~ '[a-z0-9][A-Z]'
                      AND identity_claims ? lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'))));
END $$;

-- jsonb_object_agg keeps the LAST value of a duplicate key: renamed keys are
-- aggregated first, so an existing snake_case key overrides its camelCase twin.
UPDATE integration_connections SET identity_claims = (
  SELECT jsonb_object_agg(
    CASE WHEN k ~ '[a-z0-9][A-Z]'
      THEN lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'))
      ELSE k END,
    v
    ORDER BY (k ~ '[a-z0-9][A-Z]') DESC)
  FROM jsonb_each(identity_claims) AS e(k, v))
WHERE jsonb_typeof(identity_claims) = 'object'
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(identity_claims) AS k WHERE k ~ '[a-z0-9][A-Z]');

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) INTO v_left FROM integration_connections
    WHERE jsonb_typeof(identity_claims) = 'object'
      AND EXISTS (SELECT 1 FROM jsonb_object_keys(identity_claims) AS k WHERE k ~ '[a-z0-9][A-Z]');
  RAISE NOTICE 'after: % connection(s) still carry a camelCase identity claim key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% connection(s) still carry a camelCase identity claim key — aborting', v_left;
  END IF;
END $$;

COMMIT;
