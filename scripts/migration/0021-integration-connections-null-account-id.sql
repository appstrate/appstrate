-- 0021 — `integration_connections.account_id`: the sentinel 'default' → NULL.
--
-- Run right after deploying the release that carries drizzle `0071`: before
-- that migration the column is NOT NULL and this script fails; after it, until
-- this runs, an identity-less connection reads as an account literally named
-- 'default', so reconnecting it with a real identity is refused with 409
-- `identity_mismatch` instead of upgrading it.
--
-- ═══ WHAT IT REPAIRS ═══
--
-- The connect flow used to store the string 'default' when the provider
-- exposed no identity (an API key, a login secret, a token response with no
-- identity claim), and special-cased it everywhere as "no identity". NULL now
-- carries that meaning and 'default' is an ordinary account id. Every stored
-- 'default' was written by the sentinel: the identity chain reads an email, a
-- login or a `sub`, none of which a provider spells `default`.
--
-- ═══ WHAT IT DOES ═══
--
-- One `UPDATE`, on the rows that still read 'default': a second run matches
-- nothing. `label` is untouched — it was fixed at creation ("Connexion N" for
-- these rows) and never read the account id again.
--
-- ═══ PRE-FLIGHT (read-only) ═══
--
--   SELECT count(*) FROM integration_connections WHERE account_id = 'default';
--
-- Rows: UNMEASURED — not rehearsed against a restored dump. Do that first
-- (README requirement 4) and record the count the script prints.

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
