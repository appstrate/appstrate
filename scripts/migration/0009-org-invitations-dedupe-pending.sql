-- 0009 — one pending invitation per (organization, email).
--
-- Run BEFORE `packages/db/drizzle/0057_org_invitations_pending_unique.sql`
-- when — and only when — that migration's `CREATE UNIQUE INDEX` fails with
-- `could not create unique index "uq_org_invitations_pending"`. Under the old
-- `createInvitation` a duplicate pending pair could only be produced by two
-- creates racing each other (each cancelled the other's predecessor, then both
-- inserted), so most deployments have nothing to repair and the migration
-- simply succeeds.
--
-- Keeps the NEWEST pending row per pair (the one whose link was shared last)
-- and cancels the older ones. Nothing is deleted.
--
-- Idempotent: the WHERE is exactly the condition it removes — an older pending
-- sibling — so a second run matches zero rows. One transaction, fenced.
--
-- Rows: UNMEASURED — the script prints the pair count before and after; the
-- "after" count must be 0 for `0057` to succeed.

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
