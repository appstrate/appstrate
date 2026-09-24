-- 0026 — rename the `package_id` / `run_id` keys to `packageId` / `runId` in
-- `notifications.payload` (#1545 D8, CASING_CONVENTIONS 4b). The payload is
-- returned verbatim by `GET /api/notifications`; its other keys (`agent_id`,
-- `status`, `package_type`, `shared_by_name`) are unchanged. Current code only
-- writes `package_id` (`package_shared`); `run_id` is renamed for any older row.
-- Run INSIDE the deploy window (old app stopped, new one not started): each
-- build reads only its own spelling, so a share notice in the other one names
-- no package. Cost: one sequential scan of `notifications` (no index on the
-- payload), UPDATEs only the rows still holding a snake key; idempotent.
-- Rows: UNMEASURED — rehearse on a restored dump first (README requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % notification(s) with package_id, % with run_id to rewrite',
    (SELECT count(*) FROM notifications WHERE payload ? 'package_id'),
    (SELECT count(*) FROM notifications WHERE payload ? 'run_id');
END $$;

UPDATE notifications SET payload = (payload - 'package_id')
    || jsonb_build_object('packageId', payload -> 'package_id')
WHERE payload ? 'package_id';

UPDATE notifications SET payload = (payload - 'run_id')
    || jsonb_build_object('runId', payload -> 'run_id')
WHERE payload ? 'run_id';

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) FROM notifications WHERE payload ?| ARRAY['package_id', 'run_id']
  INTO v_left;
  RAISE NOTICE 'after: % notification(s) still carry a package_id/run_id key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% notification(s) still carry a package_id/run_id key — aborting', v_left;
  END IF;
END $$;

COMMIT;
