-- 0026 — rewrite every top-level key of `integration_connections.identity_claims`
-- that is not snake_case into its snake_case form (#1545 D10): `accountId` →
-- `account_id`, `avatarUrl` → `avatar_url`, `teamName` → `team_name`, … Generic,
-- not a name list: a key is rewritten iff it does not match the write-path rule
-- (`findNonSnakeCaseIdentityClaimKeys`, `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`), as
-- `lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'))`. Conforming
-- keys (`sub`, `email`, `account_id`, …) are untouched; values never change.
-- When a row holds both spellings, the one already snake_case wins. A key the
-- conversion cannot make conform (`team-name`, `_id`, …) aborts the script,
-- named, before anything is committed: fix it by hand, then re-run.
-- The bag is display data returned verbatim on the wire (the one key read off
-- it, `/api/me/connections`' `account_email`, only picks a label), so run it
-- once AFTER deploying the release whose system manifests declare snake_case
-- keys: the old build keeps writing camelCase ones until it stops. The
-- `account_id` column is not touched.
-- Cost: UPDATEs only the rows still holding a non-conforming key; idempotent.
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
                    WHERE k !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$')),
    (SELECT count(*) FROM integration_connections
      WHERE jsonb_typeof(identity_claims) = 'object'
        AND EXISTS (SELECT 1 FROM jsonb_object_keys(identity_claims) AS k
                    WHERE k !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
                      AND lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g')) <> k
                      AND identity_claims ? lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'))));
END $$;

-- jsonb_object_agg keeps the LAST value of a duplicate key: rewritten keys are
-- aggregated first, so an existing snake_case key overrides its twin.
UPDATE integration_connections SET identity_claims = (
  SELECT jsonb_object_agg(
    CASE WHEN k !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
      THEN lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'))
      ELSE k END,
    v
    ORDER BY (k !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$') DESC, k)
  FROM jsonb_each(identity_claims) AS e(k, v))
WHERE jsonb_typeof(identity_claims) = 'object'
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(identity_claims) AS k
              WHERE k !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$');

-- ═══ After — re-derived from the table, with the write-path rule ════════════

DO $$
DECLARE
  v_left bigint;
  v_keys text;
BEGIN
  SELECT count(DISTINCT c.id), string_agg(DISTINCT k, ', ')
    INTO v_left, v_keys
    FROM integration_connections c, jsonb_object_keys(c.identity_claims) AS k
   WHERE jsonb_typeof(c.identity_claims) = 'object'
     AND k !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$';
  RAISE NOTICE 'after: % connection(s) still carry a non-snake_case identity claim key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% connection(s) still carry a non-snake_case identity claim key (%) — aborting',
      v_left, v_keys;
  END IF;
END $$;

COMMIT;
