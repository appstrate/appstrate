-- Remove 'built-in' from the package_source enum.
-- Drop the column default first (it references the old enum type and blocks ALTER TYPE).
ALTER TABLE "packages" ALTER COLUMN "source" DROP DEFAULT;
ALTER TYPE "public"."package_source" RENAME TO "package_source_old";
CREATE TYPE "public"."package_source" AS ENUM('local', 'system');
-- Convert column: map 'built-in' → 'system', keep others as-is
ALTER TABLE "packages" ALTER COLUMN "source" TYPE "public"."package_source"
  USING (CASE WHEN "source"::text = 'built-in' THEN 'system'::"public"."package_source" ELSE "source"::text::"public"."package_source" END);
ALTER TABLE "packages" ALTER COLUMN "source" SET DEFAULT 'local'::"public"."package_source";
DROP TYPE "public"."package_source_old";
