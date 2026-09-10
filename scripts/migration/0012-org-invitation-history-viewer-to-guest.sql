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
-- ═══ WHY THIS IS A FILE AND NOT A SIXTH STATEMENT IN `0008` ═══
--
-- The argument above is about widening `0008`'s existing WHERE. It does not
-- reach the obvious alternative — a SEPARATE statement inside `0008`, which
-- would touch neither `mig0008_invitations` (captured `pending` only) nor step
-- 5's predicates, and would break nothing. Nor does immutability: this
-- directory has no such rule, and `0008` is in no released tag, so amending it
-- was mechanically available. The reason not to is neither of those:
--
-- `0008` DOES NOT REDO ITS STEP 4 OUTSIDE ITS WINDOW, so "amend it" and "ship
-- the fix" are not the same act. Its step 4 capture predicate is
-- `signup_role = 'guest' AND signup_space_assignments = '[]'::jsonb`, and that
-- is permanent — it would re-match ANY client still holding an empty snapshot,
-- including one an admin deliberately left with no assignments, and including
-- one whose org simply had no space at the time. That is why a `0008` run that
-- commits records itself in `drizzle.migration_scripts` and every later run
-- captures an EMPTY step-4 set, writing nothing. `0008`'s own header says so.
--
-- That guard stops a re-run from widening the auto-provisioning path; it does
-- not make `0008` the place for this UPDATE. Folding it in ships the fix as
-- "re-run `0008`" — a five-table, 300-second transaction over the whole
-- database, to repair a handful of invitation rows, whose step-4 behaviour now
-- depends on whether the operator's marker row exists. `main` is a documented
-- build path and `0008` has been on it since 2026-09-08, so the operator who
-- has already run it is precisely the one this file is for, and a bare UPDATE
-- on one column of one table — no window, no captured set — is the shape that
-- can be handed to them.
--
-- Second, independently: the `pending_before` / `pending_after` counters below
-- are a cross-check on a DIFFERENT script — non-zero means `0008` has not run.
-- Folded into `0008` they would be self-referential and prove nothing.
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
