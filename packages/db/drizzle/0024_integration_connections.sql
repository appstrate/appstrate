-- Phase 1.1 — INTEGRATIONS_PROPOSAL §4.1.8 (multi-auth storage model).
--
-- Backing table for the new AFPS integration manifest's `auths.{key}`
-- connections. One row per (integration package, auth key, account id,
-- application, owner). Mirrors the v1-envelope encryption used by
-- `user_provider_connections` so the same `@appstrate/connect/encryption`
-- primitives serve both legacy provider and new integration flows.
--
-- Owner = dashboard user XOR headless end-user (mirrors
-- `connection_profiles`). The uniqueness index uses `coalesce(col, '')`
-- so PostgreSQL's "NULLs are distinct" rule doesn't permit multiple
-- "same-owner" rows.

CREATE TABLE IF NOT EXISTS "integration_connections" (
    "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "integration_package_id"   text NOT NULL,
    "auth_key"                 text NOT NULL,
    "account_id"               text NOT NULL,
    "application_id"           text NOT NULL,
    "user_id"                  text,
    "end_user_id"              text,
    "credentials_encrypted"    text NOT NULL,
    "identity_claims"          jsonb,
    "scopes_granted"           text[] NOT NULL DEFAULT '{}'::text[],
    "needs_reconnection"       boolean NOT NULL DEFAULT false,
    "expires_at"               timestamp,
    "created_at"               timestamp NOT NULL DEFAULT now(),
    "updated_at"               timestamp NOT NULL DEFAULT now(),
    CONSTRAINT "integration_conn_exactly_one_owner" CHECK (
        (user_id IS NOT NULL AND end_user_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NOT NULL)
    )
);

DO $$ BEGIN
    ALTER TABLE "integration_connections"
        ADD CONSTRAINT "integration_connections_integration_package_id_packages_id_fk"
        FOREIGN KEY ("integration_package_id") REFERENCES "packages"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_connections"
        ADD CONSTRAINT "integration_connections_application_id_applications_id_fk"
        FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_connections"
        ADD CONSTRAINT "integration_connections_user_id_user_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_connections"
        ADD CONSTRAINT "integration_connections_end_user_id_end_users_id_fk"
        FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_conn_unique"
    ON "integration_connections" (
        "integration_package_id",
        "auth_key",
        "account_id",
        "application_id",
        coalesce("user_id", ''),
        coalesce("end_user_id", '')
    );

CREATE INDEX IF NOT EXISTS "idx_integration_conn_user"
    ON "integration_connections" ("user_id")
    WHERE "user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_integration_conn_end_user"
    ON "integration_connections" ("end_user_id")
    WHERE "end_user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_integration_conn_app"
    ON "integration_connections" ("application_id");

CREATE INDEX IF NOT EXISTS "idx_integration_conn_package"
    ON "integration_connections" ("integration_package_id");
