-- 0023 — revoke the stored API keys minted in the retired `ask_` format.
--
-- Run once, AFTER deploying the release that introduced the checksummed
-- `apst_` format. `scripts/migration/README.md` → "Detail — Retired API-key
-- format".
--
-- ═══ WHAT IT REPAIRS ═══
--
-- From that release on, `validateApiKey` refuses an `ask_` key with 401
-- `api_key_format_retired` before any lookup, so such a row can never
-- authenticate again. Keys are stored hashed and cannot be converted. Left in
-- place, those rows would still be listed in Settings → API keys as active
-- keys that do nothing; revoked, they leave the listing like any other
-- revoked key, and the audit trail keeps pointing at their ids.
--
-- ═══ WHAT IT DOES ═══
--
-- Sets `revoked_at` = now() on every key whose `key_prefix` starts with
-- `ask_` and is not revoked yet. `revoked_at` is the column the platform's own
-- revoke writes, so no row is deleted: `runs.api_key_id` and the audit trail
-- keep resolving. Idempotent without a marker: the predicate is the condition
-- the write removes. One transaction, fenced, one `UPDATE`.
--
-- ═══ PRE-FLIGHT (read-only) ═══
--
--   SELECT count(*) FROM api_keys
--   WHERE starts_with(key_prefix, 'ask_') AND revoked_at IS NULL;
--
-- Rows: UNMEASURED — not rehearsed against a restored dump. Do that first
-- (README requirement 4) and record the count the script prints.

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
