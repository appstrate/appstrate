-- SPDX-License-Identifier: Apache-2.0
-- Run with writers stopped after a nonzero 0052 notification scope preflight.
-- Restore only the space, within the original organization, for the run's own recipient.
-- Actor-less runs, unverified recipients and cross-organization cases require operator review.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

UPDATE notifications n SET space_id = r.space_id
FROM runs r JOIN spaces s ON s.id = r.space_id AND s.org_id = r.org_id
WHERE n.type IN ('run_completed', 'run_failed') AND n.run_id = r.id
  AND n.org_id = r.org_id AND n.space_id IS DISTINCT FROM r.space_id
  AND ((n.recipient_type = 'user' AND n.recipient_id = r.user_id
        AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = r.org_id AND m.user_id = n.recipient_id))
    OR (n.recipient_type = 'end_user' AND n.recipient_id = r.end_user_id
        AND EXISTS (SELECT 1 FROM end_users e WHERE e.id = n.recipient_id
          AND e.org_id = r.org_id AND e.space_id = r.space_id)))
RETURNING n.id, n.run_id, n.space_id;

-- Only identifiers are printed. Re-run before-schema after reviewing any remaining rows.
SELECT n.id, n.run_id, n.recipient_type, n.recipient_id, n.org_id, n.space_id,
       r.org_id AS run_org_id, r.space_id AS run_space_id
FROM notifications n
LEFT JOIN runs r ON r.id = n.run_id
LEFT JOIN spaces s ON s.id = r.space_id AND s.org_id = r.org_id
WHERE n.type IN ('run_completed', 'run_failed') AND n.run_id IS NOT NULL
  AND (s.id IS NULL OR n.org_id IS DISTINCT FROM r.org_id OR n.space_id IS DISTINCT FROM r.space_id);
COMMIT;
