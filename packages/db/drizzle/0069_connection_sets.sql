DROP INDEX "idx_integration_pins_unique";--> statement-breakpoint
DROP INDEX "idx_integration_org_defaults_unique";--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_pins_unique" ON "integration_pins" USING btree ("space_id","package_id","integration_package_id",coalesce("user_id", ''),"connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_org_defaults_unique" ON "integration_org_defaults" USING btree ("space_id","integration_package_id","connection_id");