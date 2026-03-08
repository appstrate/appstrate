-- Make orgId nullable on packages and package_versions for system providers (orgId = NULL)
ALTER TABLE "packages" ALTER COLUMN "org_id" DROP NOT NULL;
ALTER TABLE "package_versions" ALTER COLUMN "org_id" DROP NOT NULL;

-- Data migration: set orgId to NULL for system providers.
-- Uses text comparison to avoid "unsafe use of new enum value" within transaction.
UPDATE "packages" SET "org_id" = NULL WHERE "source"::text = 'system';
UPDATE "package_versions" SET "org_id" = NULL
  WHERE "package_id" IN (SELECT "id" FROM "packages" WHERE "source"::text = 'system');
