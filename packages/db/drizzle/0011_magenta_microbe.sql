ALTER TABLE "execution_logs" ADD COLUMN "level" text DEFAULT 'debug' NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."package_version_dependencies" ALTER COLUMN "dep_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "public"."packages" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."package_type";--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('flow', 'skill', 'tool', 'provider');--> statement-breakpoint
ALTER TABLE "public"."package_version_dependencies" ALTER COLUMN "dep_type" SET DATA TYPE "public"."package_type" USING "dep_type"::"public"."package_type";--> statement-breakpoint
ALTER TABLE "public"."packages" ALTER COLUMN "type" SET DATA TYPE "public"."package_type" USING "type"::"public"."package_type";