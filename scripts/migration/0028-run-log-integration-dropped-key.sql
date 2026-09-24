-- 0028 — rename the `integrationId` key to `integration_id` in the `data` of
-- every `integration_dropped` run log (#1545, CASING_CONVENTIONS 4g boundary):
-- `run_logs.data` is returned verbatim by `GET /api/runs/{id}/logs` and the
-- run_log SSE, so its platform-written keys are Zone 1. No code reads the key
-- back (the run page renders the row), so this is consistency only: run it
-- once, after the deploy. Cost: one sequential scan of `run_logs` (no index on
-- `event` or `data`) that UPDATEs only the matching rows — the degradation
-- marker is rare; idempotent. Rows: UNMEASURED — rehearse on a restored dump
-- first (README requirement 4); the timeout below is sized for the scan.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  RAISE NOTICE 'before: % integration_dropped run log(s) to rewrite',
    (SELECT count(*) FROM run_logs
      WHERE event = 'integration_dropped' AND data ? 'integrationId');
END $$;

UPDATE run_logs SET data = (data - 'integrationId')
    || jsonb_build_object('integration_id', data -> 'integrationId')
WHERE event = 'integration_dropped' AND data ? 'integrationId';

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) FROM run_logs
    WHERE event = 'integration_dropped' AND data ? 'integrationId'
  INTO v_left;
  RAISE NOTICE 'after: % integration_dropped run log(s) still carry an integrationId key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% run log(s) still carry an integrationId key — aborting', v_left;
  END IF;
END $$;

COMMIT;
