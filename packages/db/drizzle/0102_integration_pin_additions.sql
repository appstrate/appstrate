-- An admin pin is the floor every run of its agent binds; `allow_additional_connections` opens it
-- to the run's selection (launch override, else the member pin) on top of it. Every existing pin
-- stays closed (the default), which is what every pin meant before this column. Only an admin pin
-- opens, and only over a non-empty floor: `[]` stays a closed pin to no connection.
ALTER TABLE "integration_pins" ADD COLUMN IF NOT EXISTS "allow_additional_connections" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_additions_admin_only" CHECK (user_id IS NULL OR NOT allow_additional_connections);--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_additions_need_imposed" CHECK (NOT allow_additional_connections OR cardinality(connection_ids) > 0);
