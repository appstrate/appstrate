-- 0028 — rename the platform-written camelCase keys of `run_logs.data`
-- (#1545, CASING_CONVENTIONS 4g boundary): `integrationId` → `integration_id`
-- on `integration_dropped` rows, `exitCode` → `exit_code` on
-- `firecracker_console` rows.
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
  RAISE NOTICE 'before: % integration_dropped, % firecracker_console run log(s) to rewrite',
    (SELECT count(*) FROM run_logs
      WHERE event = 'integration_dropped' AND data ? 'integrationId'),
    (SELECT count(*) FROM run_logs
      WHERE event = 'firecracker_console' AND data ? 'exitCode');
END $$;

UPDATE run_logs SET data = (data - 'integrationId')
    || jsonb_build_object('integration_id', data -> 'integrationId')
WHERE event = 'integration_dropped' AND data ? 'integrationId';

UPDATE run_logs SET data = (data - 'exitCode')
    || jsonb_build_object('exit_code', data -> 'exitCode')
WHERE event = 'firecracker_console' AND data ? 'exitCode';

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) FROM run_logs
    WHERE (event = 'integration_dropped' AND data ? 'integrationId')
       OR (event = 'firecracker_console' AND data ? 'exitCode')
  INTO v_left;
  RAISE NOTICE 'after: % run log(s) still carry a camelCase platform key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% run log(s) still carry a camelCase platform key — aborting', v_left;
  END IF;
END $$;

COMMIT;
