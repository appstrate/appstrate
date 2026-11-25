-- SPDX-License-Identifier: Apache-2.0
-- Run once, with the release that adds the `studio:read` space permission.
-- Every custom space role stored before it opened the Studio; this keeps that true. Holders of a role
-- that should not see the Studio lose it afterwards, by editing the role.
-- A second execution updates zero rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

UPDATE space_roles SET permissions = array_append(permissions, 'studio:read'), updated_at = now()
WHERE NOT ('studio:read' = ANY (permissions))
RETURNING id, org_id, key;

COMMIT;
