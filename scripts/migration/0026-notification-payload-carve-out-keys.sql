-- 0026 — rename the `package_id` / `agent_id` / `run_id` keys to `packageId` /
-- `packageId` / `runId` in `notifications.payload` (#1545 D8 + R4,
-- CASING_CONVENTIONS 4b). The payload is returned verbatim by
-- `GET /api/notifications`; its other keys (`status`, `package_type`,
-- `shared_by_name`) are unchanged. The previous build writes `package_id`
-- (`package_shared`) and `agent_id` (`run_completed`, the run's package);
-- `run_id` is renamed for any older row. A key already spelled `packageId` /
-- `runId` wins over its snake twin. Run INSIDE the deploy window (old app
-- stopped, new one not started): each build reads only its own spelling, so a
-- notice in the other one names no package and counts toward no agent. Cost: one sequential scan of `notifications` (no index on the
-- payload), UPDATEs only the rows still holding a snake key; idempotent.
-- Rows: UNMEASURED — rehearse on a restored dump first (README requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % notification(s) with package_id, % with agent_id, % with run_id to rewrite',
    (SELECT count(*) FROM notifications WHERE payload ? 'package_id'),
    (SELECT count(*) FROM notifications WHERE payload ? 'agent_id'),
    (SELECT count(*) FROM notifications WHERE payload ? 'run_id');
END $$;

-- `new || existing`: the right-hand operand wins, so an existing camelCase key is kept.
UPDATE notifications SET payload = jsonb_build_object('packageId', payload -> 'package_id')
    || (payload - 'package_id')
WHERE payload ? 'package_id';

UPDATE notifications SET payload = jsonb_build_object('packageId', payload -> 'agent_id')
    || (payload - 'agent_id')
WHERE payload ? 'agent_id';

UPDATE notifications SET payload = jsonb_build_object('runId', payload -> 'run_id')
    || (payload - 'run_id')
WHERE payload ? 'run_id';

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) FROM notifications WHERE payload ?| ARRAY['package_id', 'agent_id', 'run_id']
  INTO v_left;
  RAISE NOTICE 'after: % notification(s) still carry a package_id/agent_id/run_id key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% notification(s) still carry a package_id/agent_id/run_id key — aborting', v_left;
  END IF;
END $$;

COMMIT;
