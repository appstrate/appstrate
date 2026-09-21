-- 0014 — give every organization package a home space.
--
-- Run BETWEEN the drizzle batch carrying
-- `packages/db/drizzle/0063_packages_home_space.sql` and bringing the new
-- version up — the shape `0008` uses, for the same reason. That migration adds
-- `packages.home_space_id` and leaves it NULL on every row, and a homeless
-- organization package is a package NOBODY can write: authority is the home
-- space and nothing else, so a builder who authored an agent can no longer
-- edit it and an API key can no longer touch any package at all until this
-- script has run. So this is not optional cleanup, it is the second half of the
-- change, and nothing should be serving traffic while the two halves are apart:
--
--   stop the platform → run migrations only → run THIS script → bring the new
--   version up.
--
-- THE RULE, and it is the same one the plan states:
--   * installed in exactly one space  → that space;
--   * installed in several            → the OLDEST `installed_at`, because the
--                                       first space to install it is where it
--                                       was authored (packages auto-install in
--                                       their creating space);
--   * installed nowhere               → the organization's DEFAULT space, which
--                                       is the home of the packages that belong
--                                       to no team. Owners and admins reach it
--                                       like any other space, and a builder of
--                                       the default gains the write.
-- System packages (`org_id IS NULL`) and inline shadow rows (`ephemeral`) are
-- excluded: neither is writable through the package routes at all, and they are
-- the two exceptions `packages_org_package_has_home` names.
--
-- SEVERAL INSTALLATIONS IS THE CASE THAT NEEDS A HUMAN. "Oldest install" is a
-- good guess, not a fact — a package installed into five spaces on the same
-- import has no meaningful first. The script PRINTS those package ids, with
-- their candidate space, BEFORE the UPDATE; review them, and `ROLLBACK`
-- instead of `COMMIT` if any looks wrong. Whatever it picks stays correctable
-- afterwards: `PUT /api/packages/{scope}/{name}/home {"home_space_id": …}`
-- moves a package, and an owner or admin can always run it. That is the ONLY
-- move route — there is no `PATCH` on the package path — and `home_space_id` is
-- required there: `null` is a 400, and a personal space as destination is a
-- `409 home_move_into_personal_space`.
--
-- Idempotent: every WHERE is exactly `home_space_id IS NULL`, the condition
-- this removes, so a second run matches zero rows — including for a package an
-- operator has since moved by hand, which it will not move back. The closing
-- `VALIDATE CONSTRAINT` is idempotent in its own right (validating an already
-- validated constraint is a no-op). One transaction, fenced.
--
-- Rows: UNMEASURED — no production dump was rehearsed against this file. The
-- script prints the NULL-home count before and after and the ambiguous list in
-- between; "after" MUST be 0, and the `VALIDATE CONSTRAINT` that follows aborts
-- the whole transaction if it is not.
--
-- Pre-flight, on the replica (`ssh appstrate`): run the "before" query, the
-- ambiguity query and the missing-default query below read-only, and review the
-- multi-install list with the packages' authors.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ═══ VERIFY (before) — org packages with no home, split by what we can infer ═══
SELECT
  count(*)                                        AS no_home_before,
  count(*) FILTER (WHERE i.installs = 1)          AS exactly_one_install,
  count(*) FILTER (WHERE i.installs > 1)          AS several_installs,
  count(*) FILTER (WHERE i.installs = 0)          AS installed_nowhere
FROM packages p
JOIN LATERAL (
  SELECT count(*) AS installs
  FROM space_packages sp
  JOIN spaces s ON s.id = sp.space_id
  WHERE sp.package_id = p.id AND s.org_id = p.org_id
) i ON true
WHERE p.org_id IS NOT NULL AND p.ephemeral = false AND p.home_space_id IS NULL;

-- ═══ REVIEW — the ambiguous ones, and the space each is about to get ═══
-- Read this list before COMMIT. Every row here is a guess.
SELECT
  p.id                AS package_id,
  p.org_id,
  count(*)            AS installations,
  (array_agg(sp.space_id ORDER BY sp.installed_at, sp.space_id))[1] AS chosen_space_id,
  min(sp.installed_at) AS chosen_installed_at
FROM packages p
JOIN space_packages sp ON sp.package_id = p.id
JOIN spaces s ON s.id = sp.space_id AND s.org_id = p.org_id
WHERE p.org_id IS NOT NULL AND p.ephemeral = false AND p.home_space_id IS NULL
GROUP BY p.id, p.org_id
HAVING count(*) > 1
ORDER BY p.id;

-- ═══ REVIEW — organizations this script cannot finish: no default space ═══
-- MUST be empty. The third case below has nowhere to put these rows, the
-- closing VALIDATE would then abort the transaction, and the fix is an
-- operator's: give the organization a default space (`spaces.is_default`) and
-- re-run. Every organization provisioned by the platform has one.
SELECT p.org_id, count(*) AS homeless_packages
FROM packages p
WHERE p.org_id IS NOT NULL
  AND p.ephemeral = false
  AND p.home_space_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM spaces s WHERE s.org_id = p.org_id AND s.is_default
  )
GROUP BY p.org_id
ORDER BY p.org_id;

-- ═══ WRITE (1/2) — oldest installation in the package's own organization ═══
UPDATE packages p
SET home_space_id = chosen.space_id
FROM (
  SELECT DISTINCT ON (sp.package_id)
    sp.package_id,
    sp.space_id
  FROM space_packages sp
  JOIN spaces s ON s.id = sp.space_id
  JOIN packages pk ON pk.id = sp.package_id AND pk.org_id = s.org_id
  ORDER BY sp.package_id, sp.installed_at, sp.space_id
) chosen
WHERE p.id = chosen.package_id
  AND p.org_id IS NOT NULL
  AND p.ephemeral = false
  AND p.home_space_id IS NULL;

-- ═══ WRITE (2/2) — installed nowhere → the organization's default space ═══
UPDATE packages p
SET home_space_id = d.id
FROM spaces d
WHERE d.org_id = p.org_id
  AND d.is_default
  AND p.org_id IS NOT NULL
  AND p.ephemeral = false
  AND p.home_space_id IS NULL;

-- ═══ VERIFY (after) — MUST print 0 ═══
SELECT count(*) AS no_home_after
FROM packages p
WHERE p.org_id IS NOT NULL AND p.ephemeral = false AND p.home_space_id IS NULL;

-- ═══ TAKE THE OTHER HALF OF THE CONSTRAINT ═══
-- `0067_packages_org_home_required.sql` adds `packages_org_package_has_home`
-- NOT VALID: it has governed every INSERT and UPDATE since the drizzle batch,
-- but the rows that predate it were never checked — they could not be, since
-- this script is what fixes them. Validating here closes that half, under a
-- SHARE UPDATE EXCLUSIVE lock rather than the ACCESS EXCLUSIVE a validating
-- ADD CONSTRAINT would have taken. On a fresh database there is nothing to
-- validate and this is a no-op; if "after" above was not 0 it aborts the whole
-- transaction, which is the outcome to want.
--
-- The 60s ceiling above is for the backfill statements, whose cost is bounded
-- by the homeless rows. This one is not: it is a full scan of `packages`, whose
-- volume here is UNMEASURED (see the header), and it runs ONCE. Under the
-- ceiling, a table large enough to need more than a minute would abort the
-- WHOLE transaction — backfill included, mid-window, on a `statement_timeout`
-- error that does not say which statement raised it. `SET LOCAL` because this
-- file is a single transaction: the lift ends at COMMIT, two lines down, and
-- reaches no statement but the VALIDATE.
SET LOCAL statement_timeout = 0;
ALTER TABLE packages VALIDATE CONSTRAINT packages_org_package_has_home;

COMMIT;
