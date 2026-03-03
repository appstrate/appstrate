-- Migration 0012: Cleanup after backfill (run AFTER migrate-versions.ts script)
-- Makes columns NOT NULL, drops legacy versionNumber column, reindexes

-- Step 1: Set NOT NULL constraints on backfilled columns
ALTER TABLE "package_versions" ALTER COLUMN "version" SET NOT NULL;
ALTER TABLE "package_versions" ALTER COLUMN "integrity" SET NOT NULL;
ALTER TABLE "package_versions" ALTER COLUMN "artifact_size" SET NOT NULL;
ALTER TABLE "package_versions" ALTER COLUMN "manifest" SET NOT NULL;
ALTER TABLE "package_versions" ALTER COLUMN "org_id" SET NOT NULL;

-- Step 2: Drop old unique index on (packageId, versionNumber)
DROP INDEX IF EXISTS "package_versions_pkg_version_unique";

-- Step 3: Drop old composite index
DROP INDEX IF EXISTS "idx_package_versions_package_id";

-- Step 4: Drop legacy versionNumber column
ALTER TABLE "package_versions" DROP COLUMN "version_number";

-- Step 5: Create new unique index on (packageId, version)
CREATE UNIQUE INDEX "package_versions_pkg_version_unique"
  ON "package_versions" ("package_id", "version");

-- Step 6: Create new index on packageId only
CREATE INDEX "idx_package_versions_package_id"
  ON "package_versions" ("package_id");
