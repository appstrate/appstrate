-- Org-level integration OAuth clients (#1264): `integration_oauth_clients`
-- gains `org_id`, and `space_id IS NULL` marks an org row inherited by every
-- space of the org. The `space_id` FK to `spaces` is unchanged.
--
-- The UPDATE is the precondition of `org_id SET NOT NULL` on the same table
-- (`docs/NO_TRANSITIONAL_CODE.md` §2): every existing row is a space row, and
-- its org is its space's.
--
-- ROLLBACK: a previous build inserts without `org_id` and reads `space_id` as
-- non-null. Delete org rows (`space_id IS NULL`), then drop `org_id` NOT NULL.

ALTER TABLE "integration_oauth_clients" ADD COLUMN "org_id" uuid;--> statement-breakpoint
UPDATE "integration_oauth_clients" AS c SET "org_id" = s."org_id" FROM "spaces" AS s WHERE s."id" = c."space_id";--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ALTER COLUMN "space_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD CONSTRAINT "integration_oauth_clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD CONSTRAINT "ioc_auto_provisioned_is_space" CHECK (NOT "integration_oauth_clients"."auto_provisioned" OR "integration_oauth_clients"."space_id" IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ioc_one_org_default" ON "integration_oauth_clients" USING btree ("org_id","integration_package_id","auth_key") WHERE "integration_oauth_clients"."is_default" AND "integration_oauth_clients"."space_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_oauth_clients_org_lookup" ON "integration_oauth_clients" USING btree ("org_id","integration_package_id","auth_key");
