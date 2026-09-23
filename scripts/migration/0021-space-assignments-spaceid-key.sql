-- 0021 — rename the `space_id` key of every stored space assignment to
-- `spaceId`.
--
-- Run INSIDE the deploy window: after the old application stops, before the
-- new one starts. Either side of the window reads only its own spelling — the
-- old build reads `space_id`, the new one `spaceId` — so an assignment in the
-- other spelling is a pending invitation or an SSO signup policy that grants
-- nothing.
--
-- ═══ WHAT IT REPAIRS ═══
--
-- `SpaceAssignment` (`@appstrate/core/permissions`) is the wire shape of
-- `space_assignments` on invitations and `signupSpaceAssignments` on org-level
-- OAuth clients, and both columns store that shape verbatim:
--
--   org_invitations.space_assignments          jsonb  [{ space_id, preset_role | custom_role_id }]
--   oauth_clients.signup_space_assignments     jsonb  (same)
--
-- Its space id is now `spaceId`, the universal-id carve-out of
-- `docs/CASING_CONVENTIONS.md` (4b). The role keys are unchanged.
--
-- ═══ WHAT IT DOES ═══
--
-- Rewrites each array element that carries `space_id` into the same element
-- with the key renamed, keeping element order. Only `UPDATE`s, on the rows
-- whose array still holds a `space_id` key: a second run matches nothing.
-- Every row is rewritten, not only pending invitations — history is read back
-- by the same code.
--
-- ═══ PRE-FLIGHT (read-only) ═══
--
--   SELECT
--     (SELECT count(*) FROM org_invitations
--       WHERE jsonb_path_exists(space_assignments, '$[*].space_id')) AS invitations,
--     (SELECT count(*) FROM oauth_clients
--       WHERE jsonb_path_exists(signup_space_assignments, '$[*].space_id')) AS clients;
--
-- Rows: UNMEASURED — not rehearsed against a restored dump. Do that first
-- (README requirement 4) and record the counts the script prints.

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
