-- Connection variables (AFPS §7.12): a connection stores the variable values its user submitted
-- (NULL when the integration declares none), and an auto-provisioned OAuth client records the
-- authorization server it was registered with when that server is chosen per connection (§7.3),
-- so `idx_ioc_one_auto` keys on the issuer too. A connection also records the RFC 8707 `resource`
-- its token was requested for, which every refresh sends again (§8.6). Every existing row keeps
-- NULL: no integration declared variables, every existing client belongs to the manifest's server,
-- and an existing connection's refresh sends no resource, as before.
ALTER TABLE "integration_connections" ADD COLUMN "variables" jsonb;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "oauth_resource" text;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD COLUMN "issuer" text;--> statement-breakpoint
DROP INDEX "idx_ioc_one_auto";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ioc_one_auto" ON "integration_oauth_clients" USING btree ("space_id","integration_package_id","auth_key",coalesce("issuer", '')) WHERE "integration_oauth_clients"."auto_provisioned";--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD CONSTRAINT "ioc_issuer_is_auto" CHECK ("integration_oauth_clients"."issuer" IS NULL OR ("integration_oauth_clients"."auto_provisioned" AND "integration_oauth_clients"."issuer" <> ''));
