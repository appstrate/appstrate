-- CRIT-05 completion: remove historical `application_packages` rows that
-- attach ANOTHER org's package to an application. The pre-fix
-- `PUT /applications/:id/packages/:packageId` upserted unconditionally, so
-- such rows could be created before the atomic install/update ownership
-- checks existed. They are inert on every read path now that
-- `listInstalledPackages` / `getInstalledPackage` / the run paths all filter
-- by `orgOrSystemFilter`, but they remain garbage a future query could trip
-- over — delete them outright. The association carries no user data of its
-- own (config/model/proxy overrides for a package the org was never allowed
-- to install), so DELETE is the correct repair, not a rewrite.
--
-- System packages (`packages.org_id IS NULL`) are installable by any org and
-- are deliberately NOT touched. Naturally re-runnable: a second pass matches
-- zero rows.
DELETE FROM application_packages ap
USING applications a, packages p
WHERE ap.application_id = a.id
  AND ap.package_id = p.id
  AND p.org_id IS NOT NULL
  AND p.org_id <> a.org_id;
