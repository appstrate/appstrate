-- Migrate existing publish_scope/publish_name data into registry_scope/registry_name
UPDATE "packages"
SET "registry_scope" = "publish_scope"
WHERE "publish_scope" IS NOT NULL AND "registry_scope" IS NULL;--> statement-breakpoint

UPDATE "packages"
SET "registry_name" = "publish_name"
WHERE "publish_name" IS NOT NULL AND "registry_name" IS NULL;--> statement-breakpoint

ALTER TABLE "packages" DROP COLUMN "publish_scope";--> statement-breakpoint
ALTER TABLE "packages" DROP COLUMN "publish_name";
