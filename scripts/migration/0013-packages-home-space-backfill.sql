-- 0013 — give every organization package a home space.
--
-- Run BETWEEN the drizzle batch carrying
-- `packages/db/drizzle/0061_packages_home_space.sql` and bringing the new
-- version up — the shape `0008` uses, for the same reason. That migration adds
-- `packages.home_space_id` and leaves it NULL on every row, and NULL means
-- "organization catalogue: owners and admins only": a builder who authored an
-- agent can no longer edit it and an API key can no longer touch any package
-- at all until this script has run. So this is not optional cleanup, it is the
-- second half of the change, and nothing should be serving traffic while the
-- two halves are apart:
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
--   * installed nowhere               → left NULL, the organization catalogue,
--                                       which is already admin-only today.
-- System packages (`org_id IS NULL`) and inline shadow rows (`ephemeral`) are
-- excluded: neither is writable through the package routes at all.
--
-- SEVERAL INSTALLATIONS IS THE CASE THAT NEEDS A HUMAN. "Oldest install" is a
-- good guess, not a fact — a package installed into five spaces on the same
-- import has no meaningful first. The script PRINTS those package ids, with
-- their candidate space, BEFORE the UPDATE; review them, and `ROLLBACK`
-- instead of `COMMIT` if any looks wrong. Whatever it picks stays correctable
-- afterwards: `PATCH /api/packages/{scope}/{name} {"home_space_id": …}` moves a
-- package, and an owner or admin can always run it.
--
-- Idempotent: the WHERE is exactly `home_space_id IS NULL`, the condition it
-- removes, so a second run matches zero rows — including for a package an
-- operator has since moved by hand, which it will not move back. One
-- transaction, fenced.
--
-- Rows: UNMEASURED — no production dump was rehearsed against this file. The
-- script prints the NULL-home count before and after and the ambiguous list in
-- between; "after" is the number of packages installed nowhere, which is
-- allowed to be non-zero.
--
-- Pre-flight, on the replica (`ssh appstrate`): run the "before" query and the
-- ambiguity query below read-only, and review the multi-install list with the
-- packages' authors.

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

-- ═══ WRITE — oldest installation in the package's own organization ═══
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

-- ═══ VERIFY (after) — the remainder must be exactly the never-installed ones ═══
SELECT
  count(*) AS no_home_after,
  count(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM space_packages sp
      JOIN spaces s ON s.id = sp.space_id
      WHERE sp.package_id = p.id AND s.org_id = p.org_id
    )
  ) AS no_home_and_installed_nowhere
FROM packages p
WHERE p.org_id IS NOT NULL AND p.ephemeral = false AND p.home_space_id IS NULL;

COMMIT;
