-- `package_type` is `agent`, `skill`, `integration` (AFPS §2.1): a local MCP server is declared
-- inline on its integration. Postgres drops no enum value in place, so the type is rebuilt and both
-- columns are cast back onto it. The cast fails on a row still typed `mcp-server`; those rows are
-- moved by `scripts/migration/0054-fold-mcp-servers.ts`, run before this release boots.
ALTER TABLE "packages" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "package_version_dependencies" ALTER COLUMN "dep_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."package_type";--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('agent', 'skill', 'integration');--> statement-breakpoint
ALTER TABLE "packages" ALTER COLUMN "type" SET DATA TYPE "public"."package_type" USING "type"::package_type;--> statement-breakpoint
ALTER TABLE "package_version_dependencies" ALTER COLUMN "dep_type" SET DATA TYPE "public"."package_type" USING "dep_type"::package_type;
