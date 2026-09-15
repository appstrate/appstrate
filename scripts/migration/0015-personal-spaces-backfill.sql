-- 0015 — give every existing organization member their personal space.
--
-- Run AFTER the release carrying `packages/db/drizzle/0064_personal_spaces.sql`
-- has been deployed and validated, NOT inside the window. The opposite of
-- `0014`: nothing is degraded while this script has not run. `provisionMember`
-- creates the space at every membership door from the deploy onward, and
-- `GET /api/spaces` repairs the caller's own on first read — so a member who
-- logs in gets their space with or without this script. What the script adds is
-- the members who do NOT log in soon: their space exists before anyone shares a
-- package to them (lot 2 resolves a share target through
-- `ensurePersonalSpace`), and the row count stops moving under the operator's
-- feet.
--
-- ⚠ PRE-FLIGHT — CLOUD PLAN LIMITS. This inserts ONE `spaces` row per
-- `org_members` row. Count them first, on the replica:
--
--   SELECT count(*) AS members, count(DISTINCT org_id) AS orgs
--   FROM org_members;
--
-- and know the number before running anything. The commercial module counts
-- spaces for NOTHING today — there is no space quota to breach and no billing
-- consequence (RBAC spec §3.6) — so the count matters to exactly one reader: a
-- self-hosted operator who has imposed a per-space ceiling of their own,
-- whether in their own tooling or in whatever the row count feeds. If a space
-- limit is ever added to the commercial module, §3.6 says it counts
-- `WHERE owner_user_id IS NULL`, which excludes every row this script writes.
-- If in doubt, do not run this script at all: the lazy repair covers
-- correctness on its own.
--
-- Idempotent: the insert is guarded by `NOT EXISTS` on `(org_id,
-- owner_user_id)`, which is the partial unique index
-- `uq_spaces_org_owner`, so a second run matches zero rows. It also skips a
-- member whose personal space is currently ORPHANED — leaving `orphaned_at`
-- alone is deliberate: an orphan means the person is no longer a member, and
-- such a row cannot be produced by this insert in the first place (it reads
-- live memberships only).
--
-- The name `Mon espace` is the value the server writes
-- (`ensurePersonalSpace`, `apps/api/src/services/spaces.ts`); the SPA renders
-- its own translated label off `personal: true` and never displays this string.
--
-- ROWS: UNMEASURED. This script has not been rehearsed against a production
-- dump — the counts below are printed by the script itself, and the "after"
-- query must return zero missing.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ═══ VERIFY (before) — memberships with no personal space ═══
SELECT
  count(*) AS memberships,
  count(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM spaces s
      WHERE s.org_id = m.org_id AND s.owner_user_id = m.user_id
    )
  ) AS missing_personal_space_before
FROM org_members m;

-- ═══ WRITE — one private, non-default space per membership ═══
-- `visibility = 'private'` and `is_default = false` are the two CHECKs
-- `spaces_personal_is_private` / `spaces_personal_not_default` enforce; the id
-- shape is the one `assertSpaceId` accepts (`spc_` + a canonical UUID), minted
-- here exactly as `prefixedId("spc")` mints it. `created_by` is the member
-- themselves, which is what `ensurePersonalSpace` writes — the space is theirs,
-- and a NULL there would read as "created by a user who is gone".
INSERT INTO spaces (id, org_id, name, is_default, settings, visibility, default_role, owner_user_id, created_by)
SELECT
  'spc_' || gen_random_uuid(),
  m.org_id,
  'Mon espace',
  false,
  '{}'::jsonb,
  'private',
  'operator',
  m.user_id,
  m.user_id
FROM org_members m
WHERE NOT EXISTS (
  SELECT 1 FROM spaces s
  WHERE s.org_id = m.org_id AND s.owner_user_id = m.user_id
)
-- This optional backfill runs while the platform serves traffic. Hold the
-- membership until commit, just like ensurePersonalSpace, and let a concurrent
-- lazy repair win the unique key without aborting the batch.
FOR KEY SHARE OF m
ON CONFLICT (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL DO NOTHING;

-- ═══ VERIFY (after) — must print 0 ═══
SELECT
  count(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM spaces s
      WHERE s.org_id = m.org_id AND s.owner_user_id = m.user_id
    )
  ) AS missing_personal_space_after
FROM org_members m;

-- ═══ VERIFY (after) — every personal space satisfies its three contracts ═══
SELECT
  count(*)                                                   AS personal_spaces,
  count(*) FILTER (WHERE visibility <> 'private')             AS not_private,
  count(*) FILTER (WHERE is_default)                          AS is_default,
  count(*) FILTER (WHERE orphaned_at IS NOT NULL)             AS orphaned
FROM spaces
WHERE owner_user_id IS NOT NULL;

COMMIT;
