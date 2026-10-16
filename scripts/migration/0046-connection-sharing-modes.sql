-- SPDX-License-Identifier: Apache-2.0
-- Run once after schema migration 0099 and the 0044 share copy, with the app stopped.
-- Back up the database first. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f this-file.sql
-- For PGlite, execute this batch on the explicitly named PGLITE_DATA_DIR, app stopped.
-- Re-running changes nothing. No withdrawn access is restored.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- Personal spaces belong to one user, who already uses their own connections.
WITH removed AS (
  DELETE FROM integration_connection_shares sh
  USING spaces s
  WHERE s.id = sh.space_id AND s.owner_user_id IS NOT NULL
  RETURNING sh.connection_id, sh.space_id, sh.org_id
), touched AS (
  UPDATE integration_connections c SET updated_at = now()
  WHERE c.id IN (SELECT connection_id FROM removed)
), audited AS (
  INSERT INTO audit_events (org_id, space_id, actor_type, action, resource_type, resource_id, after)
  SELECT org_id, space_id, 'system', 'integration.connection.share_removed',
    'integration_connection', connection_id,
    jsonb_build_object('spaceId', space_id, 'reason', 'personal_space')
  FROM removed
  RETURNING id
)
SELECT count(*) AS personal_shares_removed FROM audited;

-- A stored policy with exceptions becomes specific-space mode, preserving every withdrawal.
WITH changed AS (
  UPDATE integration_connections c SET share_new_spaces = false, updated_at = now()
  WHERE c.share_new_spaces AND EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.org_id = c.org_id AND s.owner_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM integration_connection_shares sh
        WHERE sh.connection_id = c.id AND sh.space_id = s.id
      )
  )
  RETURNING c.id, c.org_id
), audited AS (
  INSERT INTO audit_events (org_id, actor_type, action, resource_type, resource_id, after)
  SELECT org_id, 'system', 'integration.connection.sharing.updated', 'integration_connection', id,
    jsonb_build_object('includeFutureSpaces', false, 'reason', 'migrated')
  FROM changed
  RETURNING id
)
SELECT count(*) AS policies_changed_to_specific_spaces FROM audited;
COMMIT;
