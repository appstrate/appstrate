-- SPDX-License-Identifier: Apache-2.0
-- Run ONCE, in the deployment window, with the previous release stopped and before the new release
-- takes traffic. The release adds the `studio:read` space permission; every custom space role stored
-- before it opened the Studio, and this keeps that true. Holders of a role that should not see the
-- Studio lose it afterwards, by editing the role.
--
-- It refuses to run once any custom role holds `studio:read`. The previous release refuses an unknown
-- permission when a role is saved, so before this script no role can hold it: a holder means the
-- script already ran, or the new release already saved a role. A re-run would otherwise grant the
-- Studio back to roles an admin narrowed on purpose. Record the printed row count in the deployment log.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE space_roles IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_holders integer;
BEGIN
  SELECT count(*) INTO v_holders FROM space_roles WHERE 'studio:read' = ANY (permissions);
  IF v_holders > 0 THEN
    RAISE EXCEPTION '% custom space role(s) already hold studio:read: 0058 already ran, or the new release already saved a role — aborting, nothing written',
      v_holders;
  END IF;
END $$;

UPDATE space_roles SET permissions = array_append(permissions, 'studio:read'), updated_at = now()
RETURNING id, org_id, key;

COMMIT;
