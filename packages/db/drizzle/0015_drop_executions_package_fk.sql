-- Drop FK constraint on executions.package_id → packages.id
-- Built-in flows don't have rows in the packages table,
-- so this FK prevents creating executions for them.
ALTER TABLE "executions" DROP CONSTRAINT IF EXISTS "executions_package_id_packages_id_fk";
