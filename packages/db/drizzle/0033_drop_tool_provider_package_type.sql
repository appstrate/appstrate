-- Drop the legacy `tool` and `provider` values from the `package_type` enum.
-- Both package types were removed; only agent/skill/integration remain and no
-- producer emits the old values. PostgreSQL cannot drop an enum value in place,
-- so recreate the type without them and re-point the two columns that use it
-- (`packages.type`, `package_version_dependencies.dep_type`). The dependent
-- unique index on `dep_type` is rebuilt automatically by ALTER COLUMN TYPE.
--
-- The two DELETEs are defensive cleanup of any stray rows (there is no
-- production data); on a clean database they match nothing. They must run
-- before the recreate, otherwise the `::text::package_type` cast would fail on
-- a row still carrying a dropped value.
DELETE FROM "package_version_dependencies" WHERE "dep_type" IN ('tool', 'provider');--> statement-breakpoint
DELETE FROM "packages" WHERE "type" IN ('tool', 'provider');--> statement-breakpoint
ALTER TYPE "package_type" RENAME TO "package_type_old";--> statement-breakpoint
CREATE TYPE "package_type" AS ENUM('agent', 'skill', 'integration');--> statement-breakpoint
ALTER TABLE "packages" ALTER COLUMN "type" TYPE "package_type" USING "type"::text::"package_type";--> statement-breakpoint
ALTER TABLE "package_version_dependencies" ALTER COLUMN "dep_type" TYPE "package_type" USING "dep_type"::text::"package_type";--> statement-breakpoint
DROP TYPE "package_type_old";
