-- Webhooks module: FK constraints to core tables.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhooks_org_id_fk') THEN
    ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhooks_application_id_fk') THEN
    ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_application_id_fk"
      FOREIGN KEY ("application_id") REFERENCES "applications" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhooks_package_id_fk') THEN
    ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_package_id_fk"
      FOREIGN KEY ("package_id") REFERENCES "packages" ("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_webhook_id_fk') THEN
    ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fk"
      FOREIGN KEY ("webhook_id") REFERENCES "webhooks" ("id") ON DELETE CASCADE;
  END IF;
END $$;
