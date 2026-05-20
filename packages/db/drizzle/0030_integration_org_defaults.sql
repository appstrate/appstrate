-- Org-wide default connection per (application, integration).
--
-- Cross-agent governance primitive that integration_pins is not: a pin is
-- keyed per (agent, integration), so forcing one connection across N agents
-- meant N rows. An org default is keyed per (application, integration) — one
-- row covers every agent that consumes the integration.
--
-- `enforce` discriminates strength:
--   enforce = false → soft default (sits above the fallback; member pins win)
--   enforce = true  → org-wide force (locks members; per-agent admin pin wins)
--
-- Resolver cascade gains two layers (see integration-connection-resolver.ts):
--   1. admin pin           (integration_pins, user_id IS NULL)
--   2. org default ENFORCE (this table, enforce = true)
--   3. run override
--   4. schedule override
--   5. member pin          (integration_pins, user_id = actor)
--   6. org default SOFT    (this table, enforce = false)
--   7. fallback

CREATE TABLE IF NOT EXISTS "integration_org_defaults" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "application_id" text NOT NULL,
    "integration_package_id" text NOT NULL,
    "connection_id" uuid NOT NULL,
    "enforce" boolean DEFAULT false NOT NULL,
    "created_by" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    ALTER TABLE "integration_org_defaults"
        ADD CONSTRAINT "integration_org_defaults_application_id_applications_id_fk"
        FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_org_defaults"
        ADD CONSTRAINT "integration_org_defaults_integration_package_id_packages_id_fk"
        FOREIGN KEY ("integration_package_id") REFERENCES "packages"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_org_defaults"
        ADD CONSTRAINT "integration_org_defaults_connection_id_integration_connections_id_fk"
        FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_org_defaults"
        ADD CONSTRAINT "integration_org_defaults_created_by_user_id_fk"
        FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- One default per (application, integration).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_org_defaults_unique"
    ON "integration_org_defaults" ("application_id", "integration_package_id");

-- Resolver hot path: load all defaults for an application in one query.
CREATE INDEX IF NOT EXISTS "idx_integration_org_defaults_app"
    ON "integration_org_defaults" ("application_id");

-- Reverse lookup for the unshare / destructive-delete impact guard.
CREATE INDEX IF NOT EXISTS "idx_integration_org_defaults_connection"
    ON "integration_org_defaults" ("connection_id");
