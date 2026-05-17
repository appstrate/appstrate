-- Phase 1.3 — INTEGRATIONS_PROPOSAL marketplace UI (admin-managed OAuth2
-- client registration per integration auth).
--
-- For OAuth2 integration auths (proposal §4.1.1 — auths.{key}.type=oauth2),
-- the upstream IdP requires a pre-registered clientId/secret. Administrators
-- register these once per application via the marketplace detail page, and
-- the connect flow drives the standard PKCE exchange against the manifest's
-- `authorizationUrl` / `tokenUrl`.
--
-- `client_secret_encrypted` carries the v1 envelope ciphertext for
-- `{ "client_secret": "..." }`. Public clients (`tokenAuthMethod=none`)
-- store an empty secret — PKCE is the security primitive there, enforced
-- at the application layer.

CREATE TABLE IF NOT EXISTS "integration_oauth_clients" (
    "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "application_id"              text NOT NULL,
    "integration_package_id"      text NOT NULL,
    "auth_key"                    text NOT NULL,
    "client_id"                   text NOT NULL,
    "client_secret_encrypted"     text NOT NULL,
    "redirect_uri"                text,
    "created_at"                  timestamp NOT NULL DEFAULT now(),
    "updated_at"                  timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE "integration_oauth_clients"
        ADD CONSTRAINT "integration_oauth_clients_application_id_applications_id_fk"
        FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "integration_oauth_clients"
        ADD CONSTRAINT "integration_oauth_clients_integration_package_id_packages_id_fk"
        FOREIGN KEY ("integration_package_id") REFERENCES "packages"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_oauth_clients_unique"
    ON "integration_oauth_clients" (
        "application_id",
        "integration_package_id",
        "auth_key"
    );

CREATE INDEX IF NOT EXISTS "idx_integration_oauth_clients_app"
    ON "integration_oauth_clients" ("application_id");

CREATE INDEX IF NOT EXISTS "idx_integration_oauth_clients_package"
    ON "integration_oauth_clients" ("integration_package_id");
