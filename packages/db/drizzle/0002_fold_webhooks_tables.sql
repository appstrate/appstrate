-- Adopt the webhooks tables into the core schema.
--
-- Previously owned + migrated by the webhooks module (its own
-- drizzle/migrations + `__drizzle_migrations_webhooks` tracking table). The
-- tables now live in the core schema and are created by the system pipeline.
--
-- Idempotent by design: on a FRESH database this creates both tables; on an
-- EXISTING install (where the module already created them) the guard makes the
-- whole block a no-op so the migrator does not fail on "relation already
-- exists". DDL is identical to the module's `0000_initial.sql` /
-- `0001_dual_signature_rotation.sql`; only the FK constraint *names* differ on
-- fresh installs (Drizzle-generated vs the module's inline `REFERENCES`),
-- which is cosmetic and functionally equivalent.
DO $$
BEGIN
	IF to_regclass('public.webhooks') IS NULL THEN
		CREATE TABLE "webhooks" (
			"id" text PRIMARY KEY NOT NULL,
			"level" text NOT NULL,
			"org_id" uuid NOT NULL,
			"application_id" text,
			"url" text NOT NULL,
			"events" text[] NOT NULL,
			"package_id" text,
			"payload_mode" text DEFAULT 'full' NOT NULL,
			"enabled" boolean DEFAULT true NOT NULL,
			"secret" text NOT NULL,
			"secret_next" text,
			"secret_next_expires_at" timestamp,
			"created_at" timestamp DEFAULT now() NOT NULL,
			"updated_at" timestamp DEFAULT now() NOT NULL,
			CONSTRAINT "webhooks_level_values" CHECK (level IN ('org', 'application')),
			CONSTRAINT "webhooks_level_check" CHECK ((level = 'org' AND application_id IS NULL) OR (level = 'application' AND application_id IS NOT NULL))
		);
		CREATE TABLE "webhook_deliveries" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"webhook_id" text NOT NULL,
			"event_id" text NOT NULL,
			"event_type" text NOT NULL,
			"status" text DEFAULT 'pending' NOT NULL,
			"status_code" integer,
			"latency" integer,
			"attempt" integer DEFAULT 1 NOT NULL,
			"error" text,
			"created_at" timestamp DEFAULT now() NOT NULL
		);
		ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;
		CREATE INDEX "idx_webhooks_org_id" ON "webhooks" USING btree ("org_id");
		CREATE INDEX "idx_webhooks_application_id" ON "webhooks" USING btree ("application_id");
		CREATE INDEX "idx_webhooks_app_enabled" ON "webhooks" USING btree ("application_id","enabled");
		CREATE INDEX "idx_webhook_deliveries_webhook_id" ON "webhook_deliveries" USING btree ("webhook_id");
		CREATE INDEX "idx_webhook_deliveries_event_id" ON "webhook_deliveries" USING btree ("event_id");
		CREATE INDEX "idx_webhook_deliveries_status" ON "webhook_deliveries" USING btree ("webhook_id","status");
	END IF;
END $$;
--> statement-breakpoint
-- Existing installs only: drop the obsolete per-module migration tracking table.
DROP TABLE IF EXISTS "__drizzle_migrations_webhooks";
