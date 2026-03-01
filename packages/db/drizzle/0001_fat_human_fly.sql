-- 1. Convert existing "registry" rows to "local"
UPDATE "public"."packages" SET "source" = 'local' WHERE "source" = 'registry';--> statement-breakpoint
-- 2. Drop default (depends on old enum type)
ALTER TABLE "public"."packages" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
-- 3. Cast column to text to release enum dependency
ALTER TABLE "public"."packages" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
-- 4. Drop old enum and create new one
DROP TYPE "public"."package_source";--> statement-breakpoint
CREATE TYPE "public"."package_source" AS ENUM('built-in', 'local');--> statement-breakpoint
-- 5. Cast column back to new enum and restore default
ALTER TABLE "public"."packages" ALTER COLUMN "source" SET DATA TYPE "public"."package_source" USING "source"::"public"."package_source";--> statement-breakpoint
ALTER TABLE "public"."packages" ALTER COLUMN "source" SET DEFAULT 'local'::"public"."package_source";
