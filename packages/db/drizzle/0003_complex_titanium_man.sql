DROP INDEX "idx_packages_scope_name";--> statement-breakpoint
ALTER TABLE "package_versions" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "keywords";--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "readme";--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "registry_ref";--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "integrity";