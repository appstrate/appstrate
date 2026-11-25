-- SPDX-License-Identifier: Apache-2.0
-- Run ONCE, in the deployment window, with the previous release stopped and before the new release
-- takes traffic. The release adds the `studio:read` space permission; every custom space role stored
-- before it opened the Studio, and this keeps that true. Holders of a role that should not see the
-- Studio lose it afterwards, by editing the role.
-- Never re-run it: it would grant the Studio back to roles an admin narrowed on purpose.
-- Record the printed row count in the deployment log.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

UPDATE space_roles SET permissions = array_append(permissions, 'studio:read'), updated_at = now()
WHERE NOT ('studio:read' = ANY (permissions))
RETURNING id, org_id, key;

COMMIT;
