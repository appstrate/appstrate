-- Provider Management module: FK constraints to core tables.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_provider_keys_org_id_fk') THEN
    ALTER TABLE "org_provider_keys" ADD CONSTRAINT "org_provider_keys_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_provider_keys_created_by_fk') THEN
    ALTER TABLE "org_provider_keys" ADD CONSTRAINT "org_provider_keys_created_by_fk"
      FOREIGN KEY ("created_by") REFERENCES "user" ("id");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_models_org_id_fk') THEN
    ALTER TABLE "org_models" ADD CONSTRAINT "org_models_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_models_provider_key_id_fk') THEN
    ALTER TABLE "org_models" ADD CONSTRAINT "org_models_provider_key_id_fk"
      FOREIGN KEY ("provider_key_id") REFERENCES "org_provider_keys" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_models_created_by_fk') THEN
    ALTER TABLE "org_models" ADD CONSTRAINT "org_models_created_by_fk"
      FOREIGN KEY ("created_by") REFERENCES "user" ("id");
  END IF;
END $$;
