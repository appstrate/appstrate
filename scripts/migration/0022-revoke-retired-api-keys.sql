-- 0022 — revoke the unrevoked API keys in the retired `ask_` format, which no
-- longer authenticate and cannot be converted (only the hash is stored), so
-- Settings stops listing them as active.
-- Run once, AFTER deploying the release carrying the `apst_` format.
-- Cost: one UPDATE setting `revoked_at`, no row deleted (`runs.api_key_id` and
-- the audit trail keep resolving); idempotent. Rows: UNMEASURED — rehearse on
-- a restored dump first (README requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % unrevoked key(s) in the ask_ format',
    (SELECT count(*) FROM api_keys
      WHERE starts_with(key_prefix, 'ask_') AND revoked_at IS NULL);
END $$;

UPDATE api_keys SET revoked_at = now()
WHERE starts_with(key_prefix, 'ask_') AND revoked_at IS NULL;

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) INTO v_left FROM api_keys
  WHERE starts_with(key_prefix, 'ask_') AND revoked_at IS NULL;
  RAISE NOTICE 'after: % unrevoked key(s) in the ask_ format', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% ask_ key(s) still unrevoked — aborting', v_left;
  END IF;
END $$;

COMMIT;
