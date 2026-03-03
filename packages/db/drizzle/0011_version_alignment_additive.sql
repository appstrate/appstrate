-- Migration 0011: Additive version alignment (safe, no data loss)
-- Adds semver columns to package_versions, creates package_dist_tags and package_version_dependencies

-- Step 1: Add nullable columns to package_versions (will be made NOT NULL in 0012 after backfill)
ALTER TABLE "package_versions" ADD COLUMN "version" text;
ALTER TABLE "package_versions" ADD COLUMN "integrity" text;
ALTER TABLE "package_versions" ADD COLUMN "artifact_size" integer;
ALTER TABLE "package_versions" ADD COLUMN "manifest" jsonb;
ALTER TABLE "package_versions" ADD COLUMN "org_id" uuid;
ALTER TABLE "package_versions" ADD COLUMN "yanked" boolean NOT NULL DEFAULT false;
ALTER TABLE "package_versions" ADD COLUMN "yanked_reason" text;

-- Step 2: Add FK from package_versions.package_id to packages.id (was missing)
ALTER TABLE "package_versions"
  ADD CONSTRAINT "package_versions_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;

-- Step 3: Add FK from package_versions.org_id to organizations.id
ALTER TABLE "package_versions"
  ADD CONSTRAINT "package_versions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- Step 4: Create package_dist_tags table
CREATE TABLE IF NOT EXISTS "package_dist_tags" (
  "package_id" text NOT NULL,
  "tag" text NOT NULL,
  "version_id" integer NOT NULL,
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "package_dist_tags_pkey" PRIMARY KEY("package_id", "tag")
);

ALTER TABLE "package_dist_tags"
  ADD CONSTRAINT "package_dist_tags_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;

ALTER TABLE "package_dist_tags"
  ADD CONSTRAINT "package_dist_tags_version_id_package_versions_id_fk"
  FOREIGN KEY ("version_id") REFERENCES "package_versions"("id") ON DELETE CASCADE;

-- Step 5: Create package_version_dependencies table
CREATE TABLE IF NOT EXISTS "package_version_dependencies" (
  "id" serial PRIMARY KEY,
  "version_id" integer NOT NULL,
  "dep_scope" text NOT NULL,
  "dep_name" text NOT NULL,
  "dep_type" "package_type" NOT NULL,
  "version_range" text NOT NULL
);

ALTER TABLE "package_version_dependencies"
  ADD CONSTRAINT "package_version_dependencies_version_id_package_versions_id_fk"
  FOREIGN KEY ("version_id") REFERENCES "package_versions"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "pkg_ver_deps_unique"
  ON "package_version_dependencies" ("version_id", "dep_scope", "dep_name", "dep_type");

CREATE INDEX IF NOT EXISTS "idx_pkg_ver_deps_version_id"
  ON "package_version_dependencies" ("version_id");
