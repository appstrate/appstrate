-- 0016 — give every installation outside its package's home the share that
-- now places it there.
--
-- Run INSIDE the window, right after `0014` — the shape `0008` uses, for the
-- same reason: nothing should serve traffic between the drizzle batch and this
-- file. From the release carrying `0066` on, a package is readable from a space
-- through exactly two placements, its HOME and a `package_shares` row (RBAC
-- spec §6.9, §6.10); an installation is no longer one. Every `space_packages`
-- row that sits outside its package's home therefore needs the share row the
-- new rule reads, or the package disappears from that space at the first
-- request — still installed, still running for a schedule, invisible on every
-- page — until somebody with `share` authority offers it again.
--
--   stop the platform → run migrations only → run 0014 → run THIS script →
--   bring the new version up.
--
-- THE RULE. One share per (package, space) where `space_packages` has a row and
-- the space is NOT `packages.home_space_id`, restricted to the organization's
-- own packages (`org_id IS NOT NULL`, `ephemeral = false`) whose space belongs
-- to the same organization. System packages are readable everywhere and take
-- no share; a NULL-home package installed somewhere is placed there by the
-- share this writes, and stays the organization's through its NULL home.
-- `shared_by` is NULL: nobody offered these, the installation predates the
-- rule, and the audit trail carries no `package.shared` event for them.
--
-- Idempotent: the insert is guarded by the primary key
-- (`package_shares_package_id_space_id_pk`, `ON CONFLICT DO NOTHING`), so a
-- second run inserts zero rows. One transaction, fenced.
--
-- Rows: UNMEASURED — no production dump was rehearsed against this file. The
-- script prints the count of installations outside their home before, and the
-- count of those STILL lacking a share after — which must be 0.
--
-- Pre-flight, on the replica (`ssh appstrate`): run the "before" query below
-- read-only. The number is the number of rows this inserts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ═══ VERIFY (before) — installations outside their package's home ═══
SELECT
  count(*) AS installed_outside_home_before,
  count(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM package_shares ps
      WHERE ps.package_id = sp.package_id AND ps.space_id = sp.space_id
    )
  ) AS without_share_before
FROM space_packages sp
JOIN packages p ON p.id = sp.package_id
JOIN spaces s ON s.id = sp.space_id AND s.org_id = p.org_id
WHERE p.org_id IS NOT NULL
  AND p.ephemeral = false
  AND (p.home_space_id IS NULL OR p.home_space_id <> sp.space_id);

-- ═══ BACKFILL ═══
INSERT INTO package_shares (package_id, space_id, shared_by)
SELECT sp.package_id, sp.space_id, NULL
FROM space_packages sp
JOIN packages p ON p.id = sp.package_id
JOIN spaces s ON s.id = sp.space_id AND s.org_id = p.org_id
WHERE p.org_id IS NOT NULL
  AND p.ephemeral = false
  AND (p.home_space_id IS NULL OR p.home_space_id <> sp.space_id)
ON CONFLICT ON CONSTRAINT package_shares_package_id_space_id_pk DO NOTHING;

-- ═══ VERIFY (after) — must print 0 ═══
SELECT count(*) AS without_share_after
FROM space_packages sp
JOIN packages p ON p.id = sp.package_id
JOIN spaces s ON s.id = sp.space_id AND s.org_id = p.org_id
WHERE p.org_id IS NOT NULL
  AND p.ephemeral = false
  AND (p.home_space_id IS NULL OR p.home_space_id <> sp.space_id)
  AND NOT EXISTS (
    SELECT 1 FROM package_shares ps
    WHERE ps.package_id = sp.package_id AND ps.space_id = sp.space_id
  );

COMMIT;
