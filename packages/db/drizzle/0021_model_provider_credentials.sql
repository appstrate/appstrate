-- Model Providers Unification — Phase 2/8
--
-- Creates `model_provider_credentials`, the unified credentials table for
-- LLM model providers (API-key + OAuth alike). Coexists with the legacy
-- `org_system_provider_keys` until the read/write paths are migrated
-- (Phases 3-5) and the legacy table is dropped (Phase 8).
--
-- See plan in PR description; spec lives at
-- `docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md` §3.

CREATE TABLE IF NOT EXISTS "model_provider_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "label" text NOT NULL,
  "provider_id" text NOT NULL,
  "credentials_encrypted" text NOT NULL,
  "base_url_override" text,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "model_provider_credentials"
  DROP CONSTRAINT IF EXISTS "model_provider_credentials_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "model_provider_credentials"
  ADD CONSTRAINT "model_provider_credentials_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id")
  REFERENCES "organizations"("id")
  ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "model_provider_credentials"
  DROP CONSTRAINT IF EXISTS "model_provider_credentials_created_by_user_id_fk";
--> statement-breakpoint

ALTER TABLE "model_provider_credentials"
  ADD CONSTRAINT "model_provider_credentials_created_by_user_id_fk"
  FOREIGN KEY ("created_by")
  REFERENCES "user"("id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_model_provider_credentials_org_id"
  ON "model_provider_credentials" ("org_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_model_provider_credentials_org_provider"
  ON "model_provider_credentials" ("org_id", "provider_id");
