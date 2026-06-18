DROP INDEX "idx_integration_oauth_clients_unique";--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ALTER COLUMN "is_default" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD COLUMN "auto_provisioned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ioc_one_default" ON "integration_oauth_clients" USING btree ("application_id","integration_package_id","auth_key") WHERE "integration_oauth_clients"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ioc_one_auto" ON "integration_oauth_clients" USING btree ("application_id","integration_package_id","auth_key") WHERE "integration_oauth_clients"."auto_provisioned";--> statement-breakpoint
CREATE INDEX "idx_integration_oauth_clients_lookup" ON "integration_oauth_clients" USING btree ("application_id","integration_package_id","auth_key");