-- 0012 — the invitations `0008` deliberately left reading `viewer`.
--
-- Run in the same maintenance window as
-- `scripts/migration/0008-org-viewer-to-guest.sql`, right after it, and BEFORE
-- the release that carries `packages/db/drizzle/0059_drop_org_viewer.sql`.
-- `0059` recreates the `org_role` type without `viewer` and cannot cast a row
-- still holding the value; its section A refuses the deploy and names this file
-- rather than failing on the cast.
--
-- ═══ WHY `0008` LEFT THESE ═══
--
-- `0008` flips `org_members` wholesale but restricts its invitation UPDATE to
-- `status = 'pending'`, because the flip there is not a flip: a pending
-- invitation also gets a `space_assignments` snapshot that reproduces the
-- viewer's reach on acceptance, and `0008`'s step 5 verifies every captured
-- invitation received one. An accepted, expired or cancelled invitation grants
-- nothing when it is looked at again — acceptance is recorded on
-- `org_members`, which `0008` already moved — so there is no reach to snapshot
-- and widening that WHERE would have made `0008` flip rows its own coverage
-- check could not account for.
--
-- Which leaves them as pure history: `role` on a non-pending invitation is a
-- record of what was once offered, and after `0059` `viewer` is not a value the
-- type can hold. `guest` is the successor `0008` chose for exactly
-- these offers, so the history reads as the same decision, taken against
-- today's vocabulary.
--
-- ═══ SCOPE — `status <> 'pending'` IS LOAD-BEARING ═══
--
-- Not a narrowing for tidiness: a pending row swallowed here would become
-- `guest` without the `space_assignments` snapshot that makes the acceptance
-- equivalent, and would be invisible to `0008` on a rerun (its WHERE would no
-- longer match). Run `0008` FIRST; if this script's "before" count includes
-- pending rows it means `0008` has not run, and `0059` will say so too.
--
-- Idempotent: the WHERE is exactly the condition it removes, so a second run
-- matches zero rows. One transaction, fenced, no INSERT and no DELETE.
--
-- Rows: UNMEASURED — not rehearsed against a production dump at the time of
-- writing. Per README requirement 4 the counts are printed by the script
-- itself; run it against a restored `pg_dump` copy first and record them.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ═══ VERIFY (before) — and it must DISCRIMINATE ═══
--
-- `history_before` is the set this script owns. `pending_before` is printed
-- beside it because a non-zero value there means `0008` has not run yet and
-- this script is being run out of order — it is NOT part of what the UPDATE
-- below matches, so the "after" pair distinguishes "nothing to do" from "0008
-- is missing".
SELECT
  (SELECT count(*) FROM org_invitations
     WHERE role = 'viewer' AND status <> 'pending')  AS history_before,
  (SELECT count(*) FROM org_invitations
     WHERE role = 'viewer' AND status = 'pending')   AS pending_before;

UPDATE org_invitations
SET role = 'guest'
WHERE role = 'viewer' AND status <> 'pending';

-- ═══ VERIFY (after) — `history_after` must print 0 ═══
--
-- `pending_after` must ALSO print 0 before `0059` can be deployed, and this
-- script is not what makes it 0 — `0008` is.
SELECT
  (SELECT count(*) FROM org_invitations
     WHERE role = 'viewer' AND status <> 'pending')  AS history_after,
  (SELECT count(*) FROM org_invitations
     WHERE role = 'viewer' AND status = 'pending')   AS pending_after,
  (SELECT count(*) FROM org_invitations
     WHERE role = 'guest' AND status <> 'pending')   AS history_guest_after;

COMMIT;
