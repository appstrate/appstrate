-- 0021 — rename the `space_id` key to `spaceId` in every element of
-- `org_invitations.space_assignments` and `oauth_clients.signup_space_assignments`
-- (the `SpaceAssignment` shape, CASING_CONVENTIONS 4b), keeping element order.
-- Run INSIDE the deploy window (old app stopped, new one not started): each
-- build reads only its own spelling, so a row in the other one grants nothing.
-- Cost: UPDATEs only the rows still holding `space_id`; idempotent. Rows:
-- UNMEASURED — rehearse on a restored dump first (README requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % invitation(s), % oauth client(s) to rewrite',
    (SELECT count(*) FROM org_invitations
      WHERE jsonb_path_exists(space_assignments, '$[*].space_id')),
    (SELECT count(*) FROM oauth_clients
      WHERE jsonb_path_exists(signup_space_assignments, '$[*].space_id'));
END $$;

UPDATE org_invitations SET space_assignments = (
  SELECT jsonb_agg(
    CASE WHEN e ? 'space_id'
      THEN (e - 'space_id') || jsonb_build_object('spaceId', e -> 'space_id')
      ELSE e END
    ORDER BY o)
  FROM jsonb_array_elements(space_assignments) WITH ORDINALITY AS a(e, o))
WHERE jsonb_path_exists(space_assignments, '$[*].space_id');

UPDATE oauth_clients SET signup_space_assignments = (
  SELECT jsonb_agg(
    CASE WHEN e ? 'space_id'
      THEN (e - 'space_id') || jsonb_build_object('spaceId', e -> 'space_id')
      ELSE e END
    ORDER BY o)
  FROM jsonb_array_elements(signup_space_assignments) WITH ORDINALITY AS a(e, o))
WHERE jsonb_path_exists(signup_space_assignments, '$[*].space_id');

-- ═══ After — re-derived from the tables ═════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM org_invitations
      WHERE jsonb_path_exists(space_assignments, '$[*].space_id'))
    + (SELECT count(*) FROM oauth_clients
      WHERE jsonb_path_exists(signup_space_assignments, '$[*].space_id'))
  INTO v_left;
  RAISE NOTICE 'after: % row(s) still carry a space_id key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% row(s) still carry a space_id key — aborting', v_left;
  END IF;
END $$;

COMMIT;
