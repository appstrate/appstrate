-- 0022 — `integration_connections.account_id`: the old no-identity sentinel
-- 'default' → NULL (every stored 'default' was written by the sentinel).
-- Run right after deploying the release carrying drizzle `0071` (before it the
-- column is NOT NULL and this fails; until this runs, reconnecting such a row
-- with a real identity answers 409 `identity_mismatch`).
-- Cost: one UPDATE on the matching rows; idempotent; `label` untouched. Rows:
-- UNMEASURED — rehearse on a restored dump first (README requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % connection(s) carry account_id = ''default''',
    (SELECT count(*) FROM integration_connections WHERE account_id = 'default');
END $$;

UPDATE integration_connections SET account_id = NULL WHERE account_id = 'default';

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) INTO v_left FROM integration_connections WHERE account_id = 'default';
  RAISE NOTICE 'after: % connection(s) still carry account_id = ''default''', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% connection(s) still carry account_id = ''default'' — aborting', v_left;
  END IF;
END $$;

COMMIT;
