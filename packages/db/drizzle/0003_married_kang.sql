ALTER TABLE "packages" drop column "scope";--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "scope" text GENERATED ALWAYS AS (substring("packages"."id" from '^(@[^/]+)/')) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_packages_scope" ON "packages" USING btree ("scope");