-- Flat-connections + pins model — replaces the connection-profile cascade
-- for integrations (providers stay on the legacy profile model for now).
--
-- Four orthogonal mechanisms, single resolver (see
-- apps/api/src/services/integration-connection-resolver.ts):
--
--   1. integration_pins                        ← admin force (this migration)
--   2. runs.connection_overrides               ← run-time pick (this migration)
--   3. package_schedules.connection_overrides  ← schedule pin (this migration)
--   4. fallback: actor's accessible connections
--      = own + (shared_with_org AND application match)
--      → 1 match → auto, 0 → not_connected, N → must_choose
--
-- block_user_connections on application_packages adds an admin gate on
-- the CREATE side (POST /api/integration-connections 403s non-admins when
-- the (application, integration) row has it true).

-- ─────────────────────────── integration_connections ───────────────────────────

ALTER TABLE "integration_connections"
    ADD COLUMN IF NOT EXISTS "label" text;

ALTER TABLE "integration_connections"
    ADD COLUMN IF NOT EXISTS "shared_with_org" boolean NOT NULL DEFAULT false;

-- Partial index for the resolver's shared-pool lookup. Keeps the index
-- tiny — only sharing rows live in it, the vast majority of personal
-- credentials never hit it.
CREATE INDEX IF NOT EXISTS "idx_integration_conn_shared"
    ON "integration_connections" ("application_id", "integration_package_id", "auth_key")
    WHERE "shared_with_org" = true;

-- ─────────────────────────── application_packages ──────────────────────────────

ALTER TABLE "application_packages"
    ADD COLUMN IF NOT EXISTS "block_user_connections" boolean NOT NULL DEFAULT false;

-- ─────────────────────────── integration_pins ──────────────────────────────────

CREATE TABLE IF NOT EXISTS "integration_pins" (
    "application_id"         text NOT NULL,
    "package_id"             text NOT NULL,
    "integration_package_id" text NOT NULL,
    "auth_key"               text NOT NULL,
    "connection_id"          uuid NOT NULL,
    "created_by"             text,
    "created_at"             timestamp NOT NULL DEFAULT now(),
    "updated_at"             timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY ("application_id", "package_id", "integration_package_id", "auth_key")
);

DO $$ BEGIN
    ALTER TABLE "integration_pins"
        ADD CONSTRAINT "integration_pins_application_id_applications_id_fk"
        FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_pins"
        ADD CONSTRAINT "integration_pins_package_id_packages_id_fk"
        FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_pins"
        ADD CONSTRAINT "integration_pins_integration_package_id_packages_id_fk"
        FOREIGN KEY ("integration_package_id") REFERENCES "packages"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_pins"
        ADD CONSTRAINT "integration_pins_connection_id_integration_connections_id_fk"
        FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_pins"
        ADD CONSTRAINT "integration_pins_created_by_user_id_fk"
        FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_integration_pins_app_pkg"
    ON "integration_pins" ("application_id", "package_id");

CREATE INDEX IF NOT EXISTS "idx_integration_pins_connection"
    ON "integration_pins" ("connection_id");

-- ─────────────────────────── runs + package_schedules ──────────────────────────

ALTER TABLE "runs"
    ADD COLUMN IF NOT EXISTS "connection_overrides" jsonb;

ALTER TABLE "runs"
    ADD COLUMN IF NOT EXISTS "resolved_connections" jsonb;

ALTER TABLE "package_schedules"
    ADD COLUMN IF NOT EXISTS "connection_overrides" jsonb;
