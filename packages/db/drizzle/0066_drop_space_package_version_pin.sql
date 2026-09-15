-- `space_packages.version_id` is gone: an installation carries no version
-- (RBAC spec §6.10).
--
-- WHY. A package placed outside its home runs the `latest` published version,
-- always — the author's publish IS the rollout, the way Copilot Studio, custom
-- GPTs, n8n and Apps Script all work. The draft belongs to whoever can WRITE
-- the package, wherever they launch it from. Dependency versions never came
-- from this column: an agent's manifest ranges resolve them against the
-- published catalogue and each run freezes what it resolved. The pin therefore
-- governed the agent's own bytes and nothing else, and what it bought — a
-- recipient stuck on a version its author had stopped maintaining, unable to
-- take a fix they could not have applied themselves — was not worth a column,
-- a `409 version_in_use` guard, an "update available" badge and a re-accept
-- path to carry it.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2). Whatever the column held is
-- discarded with it: a pinned installation becomes a `latest` one, which is
-- the rule from this migration on.
--
-- ROLLBACK: one-way. A previous build reads the column at launch, on the
-- detail page and in the export, and `updateInstalledPackage` writes it.
-- Restore the coordinated backup, or roll forward.

ALTER TABLE "space_packages" DROP CONSTRAINT "space_packages_version_id_package_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "space_packages" DROP COLUMN "version_id";
