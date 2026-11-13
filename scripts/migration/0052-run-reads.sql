-- SPDX-License-Identifier: Apache-2.0
-- Run once after deploying the release carrying drizzle 0103; the app may keep running.
-- Back up the database first. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f this-file.sql
-- For PGlite (single process), execute this batch on the PGLITE_DATA_DIR with the app stopped.
-- Re-running changes nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- 1. A run's read state moves to `run_reads`: every `run_completed` notification, read or not, is
--    the read state of its run for its recipient. A row the release already wrote (a run finished
--    after the deploy) wins.
WITH copied AS (
  INSERT INTO run_reads (run_id, org_id, space_id, recipient_type, recipient_id, read_at, created_at)
  SELECT run_id, org_id, space_id, recipient_type, recipient_id, read_at, created_at
  FROM notifications
  WHERE type = 'run_completed' AND run_id IS NOT NULL
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT count(*) AS run_reads_copied FROM copied;

-- 2. The bell keeps the runs that need attention: a notification is written only for a run that
--    ended `failed` or `timeout`. The others were read state, now in `run_reads`.
WITH removed AS (
  DELETE FROM notifications
  WHERE type = 'run_completed'
    AND coalesce(payload ->> 'status', '') NOT IN ('failed', 'timeout')
  RETURNING 1
)
SELECT count(*) AS run_notifications_removed FROM removed;

-- Every remaining run notification has its read state.
SELECT count(*) AS run_notifications_without_read_state
FROM notifications n
WHERE n.type = 'run_completed' AND n.run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM run_reads r
    WHERE r.run_id = n.run_id
      AND r.recipient_type = n.recipient_type
      AND r.recipient_id = n.recipient_id
  );
COMMIT;
