ALTER TABLE "integration_pins" DROP CONSTRAINT "integration_pins_connection_ids_cardinality";--> statement-breakpoint
ALTER TABLE "integration_org_defaults" DROP CONSTRAINT "integration_org_defaults_connection_ids_cardinality";--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_connection_ids_cardinality" CHECK (cardinality(connection_ids) BETWEEN 1 AND 20);--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ADD CONSTRAINT "integration_org_defaults_connection_ids_cardinality" CHECK (cardinality(connection_ids) BETWEEN 1 AND 20);