-- Per-(member, application) sticky default connection profile.
--
-- Each member can pin one connection profile as their personal default
-- when running agents in a given application. The credential proxy's
-- `resolveProfileId` cascade consults this table between the explicit
-- per-run override (`X-Connection-Profile-Id`) and the application's
-- default profile, so user preferences take priority over the shared
-- app default but still let an explicit per-run override win.
--
-- Absence of a row = no sticky (cascade falls through to app default).
-- We do not store an explicit "no sticky" sentinel; clearing the sticky
-- deletes the row.
--
-- Scope is member-only: end-users have their own per-end-user default
-- profile (auto-created at end-user creation) on `connection_profiles`
-- itself, which the cascade already handles.

CREATE TABLE IF NOT EXISTS "user_application_profiles" (
  "user_id" text NOT NULL,
  "application_id" text NOT NULL,
  "profile_id" uuid NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_application_profiles_pkey" PRIMARY KEY ("user_id", "application_id")
);

DO $$ BEGIN
  ALTER TABLE "user_application_profiles"
    ADD CONSTRAINT "user_application_profiles_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_application_profiles"
    ADD CONSTRAINT "user_application_profiles_application_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_application_profiles"
    ADD CONSTRAINT "user_application_profiles_profile_id_fk"
    FOREIGN KEY ("profile_id") REFERENCES "connection_profiles"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_uap_application_id"
  ON "user_application_profiles" ("application_id");

CREATE INDEX IF NOT EXISTS "idx_uap_profile_id"
  ON "user_application_profiles" ("profile_id");
