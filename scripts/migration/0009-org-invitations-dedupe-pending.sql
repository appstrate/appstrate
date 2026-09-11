-- 0009 — one pending invitation per (organization, email).
--
-- Run BEFORE the drizzle batch that carries
-- `packages/db/drizzle/0056_space_roles.sql`, when — and only when — the
-- rollout pre-flight in `README.md` counts a duplicate pending pair. Not
-- afterwards: letting `0056`'s `CREATE UNIQUE INDEX` raise 23505 rolls the
-- whole migration back. A duplicate pair
-- needs two `createInvitation` calls that raced, so most deployments count zero
-- and never run this.
--
-- Keeps the NEWEST pending row per pair (the one whose link was shared last)
-- and cancels the older ones. Nothing is deleted.
--
-- Idempotent: the WHERE is exactly the condition it removes — an older pending
-- sibling — so a second run matches zero rows. One transaction, fenced.
--
-- Rows: UNMEASURED — the script prints the pair count before and after; the
-- "after" count must be 0 for `0056` to succeed.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ═══ VERIFY (before) — pairs with more than one pending row ═══
SELECT count(*) AS duplicate_pairs_before
FROM (
  SELECT org_id, email
  FROM org_invitations
  WHERE status = 'pending'
  GROUP BY org_id, email
  HAVING count(*) > 1
) d;

UPDATE org_invitations older
SET status = 'cancelled'
FROM org_invitations newer
WHERE older.status = 'pending'
  AND newer.status = 'pending'
  AND older.org_id = newer.org_id
  AND older.email = newer.email
  AND (older.created_at, older.id) < (newer.created_at, newer.id);

-- ═══ VERIFY (after) — must print 0 ═══
SELECT count(*) AS duplicate_pairs_after
FROM (
  SELECT org_id, email
  FROM org_invitations
  WHERE status = 'pending'
  GROUP BY org_id, email
  HAVING count(*) > 1
) d;

COMMIT;
