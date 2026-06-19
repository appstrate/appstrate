DROP INDEX "idx_org_models_one_default";--> statement-breakpoint
DROP INDEX "idx_org_proxies_one_default";--> statement-breakpoint
DROP INDEX "idx_integration_oauth_clients_unique";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "default_model_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "default_proxy_id" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "client_ref" text;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD COLUMN "auto_provisioned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ioc_one_default" ON "integration_oauth_clients" USING btree ("application_id","integration_package_id","auth_key") WHERE "integration_oauth_clients"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ioc_one_auto" ON "integration_oauth_clients" USING btree ("application_id","integration_package_id","auth_key") WHERE "integration_oauth_clients"."auto_provisioned";--> statement-breakpoint
CREATE INDEX "idx_integration_oauth_clients_lookup" ON "integration_oauth_clients" USING btree ("application_id","integration_package_id","auth_key");--> statement-breakpoint
ALTER TABLE "org_models" DROP COLUMN "is_default";--> statement-breakpoint
ALTER TABLE "org_proxies" DROP COLUMN "is_default";