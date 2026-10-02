-- 0037 — name why a schedule disabled before `disabled_reason` existed was disabled (#1641).
--
-- Drizzle `0079` labels every already-disabled schedule `user`. Three system paths disabled rows
-- before it without recording why; one is derivable: a MEMBER actor (`user_id`) that is no
-- longer a member of the schedule's organization left or was removed (CRIT-13), so its row
-- becomes `actor_left_org` — a row its actor paused before leaving too, which is as true.
-- Two are NOT derived and stay `user`: `actor_invalid` (a fire found the actor could not run
-- agents in the space: the space-role rule lives in TypeScript, and today's roles need not be
-- those of the fire), and `connection_deleted` (deleting a connection emptied an override set:
-- the override naming the deleted connection was removed with it).
-- Run any time after `0079` is applied. Rows: UNMEASURED. Idempotent; one transaction.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'package_schedules' AND column_name = 'disabled_reason') THEN
    RAISE EXCEPTION '0037: package_schedules.disabled_reason does not exist — apply drizzle 0079 (boot the release) first. Nothing was written.';
  END IF;
END $$;

CREATE TEMP TABLE _0037_departed ON COMMIT DROP AS
SELECT s.id FROM package_schedules s
WHERE s.enabled = false
  AND s.disabled_reason = 'user'
  AND s.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = s.org_id AND m.user_id = s.user_id);

-- ═══ VERIFY (before) ═══
SELECT count(*) AS schedules_to_relabel FROM _0037_departed;

UPDATE package_schedules s
SET disabled_reason = 'actor_left_org'
FROM _0037_departed d
WHERE s.id = d.id;

-- ═══ VERIFY (after) — the totals per reason; the CHECK `0079` added keeps every row's reason
-- consistent with `enabled` ═══
SELECT disabled_reason, count(*) FROM package_schedules WHERE enabled = false
GROUP BY disabled_reason ORDER BY disabled_reason;

COMMIT;
