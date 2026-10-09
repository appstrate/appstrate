-- A connection's scope is the tier of the OAuth client that minted it (#1870): it gains `org_id`,
-- and `space_id` NULL marks an org-scoped row (system or org client, or none). `shared_with_org`
-- becomes `shared_space_ids`, the spaces it is shared with; a label is unique per owner.
--
-- Both UPDATEs are licensed by `docs/NO_TRANSITIONAL_CODE.md` §2: `org_id` is the precondition of
-- its `SET NOT NULL`, and `shared_space_ids` folds `shared_with_org`, dropped in this file. Every
-- existing row stays space-scoped and keeps today's reach; widening them is
-- `scripts/migration/0041-widen-connections-to-org-scope.ts`, run after the deploy.
--
-- An auto-provisioned (DCR/CIMD) OAuth client may now sit at org tier: its CHECK goes, and
-- `idx_ioc_one_auto` keys on (org, tier). Existing space-tier ones stay valid.
ALTER TABLE "integration_connections" ADD COLUMN "org_id" uuid;--> statement-breakpoint
UPDATE "integration_connections" AS c SET "org_id" = s."org_id" FROM "spaces" AS s WHERE s."id" = c."space_id";--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "space_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "origin_space_id" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_origin_space_id_spaces_id_fk" FOREIGN KEY ("origin_space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "shared_space_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "integration_connections" SET "shared_space_ids" = ARRAY["space_id"] WHERE "shared_with_org";--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_end_user_not_shared";--> statement-breakpoint
DROP INDEX "idx_integration_conn_shared";--> statement-breakpoint
ALTER TABLE "integration_connections" DROP COLUMN "shared_with_org";--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_end_user_not_shared" CHECK (cardinality(shared_space_ids) = 0 OR user_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_end_user_is_space" CHECK (end_user_id IS NULL OR space_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_origin_is_org" CHECK (origin_space_id IS NULL OR space_id IS NULL);--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_space_shares_own" CHECK (space_id IS NULL OR shared_space_ids <@ ARRAY[space_id]);--> statement-breakpoint
DROP INDEX "idx_integration_conn_label";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_conn_owner_label" ON "integration_connections" USING btree ("org_id",coalesce("space_id", ''),"integration_package_id",coalesce("user_id", "end_user_id"),"label");--> statement-breakpoint
CREATE INDEX "idx_integration_conn_org" ON "integration_connections" USING btree ("org_id","integration_package_id","auth_key");--> statement-breakpoint
CREATE INDEX "idx_integration_conn_space" ON "integration_connections" USING btree ("space_id") WHERE "integration_connections"."space_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_conn_origin" ON "integration_connections" USING btree ("origin_space_id") WHERE "integration_connections"."origin_space_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_conn_shared" ON "integration_connections" USING gin ("shared_space_ids");--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" DROP CONSTRAINT "ioc_auto_provisioned_is_space";--> statement-breakpoint
DROP INDEX "idx_ioc_one_auto";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ioc_one_auto" ON "integration_oauth_clients" USING btree ("org_id",coalesce("space_id", ''),"integration_package_id","auth_key",coalesce("issuer", '')) WHERE "integration_oauth_clients"."auto_provisioned";
