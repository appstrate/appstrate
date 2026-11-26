-- SPDX-License-Identifier: Apache-2.0
-- Run ONCE, in the deployment window, with the previous release stopped and before the new release
-- takes traffic. The release adds the `studio:read` space permission; every custom space role stored
-- before it opened the Studio, and this keeps that true. Holders of a role that should not see the
-- Studio lose it afterwards, by editing the role.
--
-- NOT idempotent, on purpose: the UPDATE has no WHERE, so a re-run is not a no-op. It is guarded
-- instead: it refuses to run while any custom role holds `studio:read`. The previous release refuses
-- an unknown permission when a role is saved, so before this script no role can hold it: a holder
-- means the script already ran, or the new release already saved a role. A re-run would otherwise
-- grant the Studio back to roles an admin narrowed on purpose.
--
-- LIMIT OF THE GUARD. It sees only the current state. If no role holds `studio:read` any more (an
-- admin removed it everywhere, or the only roles saved since the release lack it), a re-run passes
-- the guard and grants it to every role again. Run it once, never again. No boot check detects a
-- forgotten run (a role without `studio:read` is also a legitimate state), so if it was forgotten
-- and the new release already saved roles, do NOT run this file: append `studio:read` by hand to the
-- roles created before the deploy time that lack it (README, 0058 section).
--
-- Record the printed rows in the deployment log. The last query must return 0.
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


-- Must be 0.
SELECT count(*) AS custom_roles_without_studio_read
FROM space_roles
WHERE NOT ('studio:read' = ANY (permissions));
COMMIT;
