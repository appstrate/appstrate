-- 0022 — `integration_connections.account_id`: the old no-identity sentinel
-- 'default' → NULL. A stored 'default' is ambiguous: the sentinel wrote it, but
-- so does a provider whose real account is literally named "default". Only the
-- second leaves evidence — the value among the row's extracted
-- `identity_claims` (a jsonb object of claim → value) — so a row whose claims
-- carry the string "default" is a real identity and is NOT rewritten. (A real
-- "default" read from an unmapped top-level email/sub leaves no such evidence
-- and cannot be told from the sentinel; it becomes NULL.)
-- Run right after deploying the release carrying drizzle `0071` (before it the
-- column is NOT NULL and this fails; until this runs, reconnecting a sentinel
-- row with a real identity answers 409 `identity_mismatch`).
-- Cost: one UPDATE on the matching rows; idempotent (a re-run matches nothing);
-- `label` untouched. Rows: UNMEASURED — rehearse on a restored dump first
-- (README requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- `@?` is NULL for a NULL `identity_claims`; lax mode yields no match on a
-- non-object, so no row can make the predicate throw.
CREATE TEMP VIEW sentinel_0022 AS
  SELECT id,
         COALESCE(identity_claims @? '$.* ? (@ == "default")', false) AS real_identity
    FROM integration_connections
   WHERE account_id = 'default';

DO $$
BEGIN
  RAISE NOTICE 'before: % sentinel row(s) to rewrite, % real "default" identit(y/ies) kept',
    (SELECT count(*) FROM sentinel_0022 WHERE NOT real_identity),
    (SELECT count(*) FROM sentinel_0022 WHERE real_identity);
END $$;

UPDATE integration_connections SET account_id = NULL
 WHERE id IN (SELECT id FROM sentinel_0022 WHERE NOT real_identity);

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
  v_kept bigint;
BEGIN
  SELECT count(*) FILTER (WHERE NOT real_identity), count(*) FILTER (WHERE real_identity)
    INTO v_left, v_kept FROM sentinel_0022;
  RAISE NOTICE 'after: % sentinel row(s) left, % real "default" identit(y/ies) kept', v_left, v_kept;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% sentinel row(s) still carry account_id = ''default'' — aborting', v_left;
  END IF;
END $$;

DROP VIEW sentinel_0022;

COMMIT;
