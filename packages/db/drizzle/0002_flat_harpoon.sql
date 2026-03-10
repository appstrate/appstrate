ALTER TABLE "packages" ADD COLUMN "scope" text GENERATED ALWAYS AS (substring("packages"."id" from '^@([^/]+)/')) STORED;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "name" text GENERATED ALWAYS AS (substring("packages"."id" from '^@[^/]+/(.+)$')) STORED;--> statement-breakpoint
CREATE INDEX "idx_packages_scope" ON "packages" USING btree ("scope");