-- OAuth + API-key Model Provider Credentials — unified table.
--
-- Retires `org_system_provider_keys` and folds API-key + OAuth credentials
-- into a single discriminated-blob table keyed by canonical `provider_id`
-- (free-text registry key contributed by a loaded module). The blob
-- carries `{ kind: "api_key" | "oauth", ... }` encrypted at rest via
-- `@appstrate/connect`'s versioned envelope.
--
-- Also renames `org_models.api` → `org_models.api_shape` for naming
-- consistency with the registry, and adds `runs.model_credential_id` as
-- the per-run pin that gates `/internal/oauth-token/:credentialId`.
--
-- Spec: docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md

-- 1. New unified credentials table.
CREATE TABLE "model_provider_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "label" text NOT NULL,
  "provider_id" text NOT NULL,
  "credentials_encrypted" text NOT NULL,
  "base_url_override" text,
  -- Denormalized OAuth expiry: the refresh worker scan filters by this
  -- column rather than decrypting every blob. Encrypted blob stays the
  -- source of truth; this column is kept in sync by writers.
  "expires_at" timestamp,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "model_provider_credentials"
  ADD CONSTRAINT "model_provider_credentials_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "model_provider_credentials"
  ADD CONSTRAINT "model_provider_credentials_created_by_user_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "user"("id");
--> statement-breakpoint

CREATE INDEX "idx_model_provider_credentials_org_id"
  ON "model_provider_credentials" ("org_id");
--> statement-breakpoint

CREATE INDEX "idx_model_provider_credentials_org_provider"
  ON "model_provider_credentials" ("org_id", "provider_id");
--> statement-breakpoint

-- Partial index: only OAuth rows have a non-null `expires_at`. Keeps the
-- index footprint proportional to OAuth-row count.
CREATE INDEX "idx_model_provider_credentials_expires_at_oauth"
  ON "model_provider_credentials" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint

-- 2. Retire `org_system_provider_keys` and re-point `org_models` at the
--    new credentials table. Renames `provider_key_id` → `credential_id`
--    in the same step for naming consistency.
ALTER TABLE "org_models"
  DROP CONSTRAINT IF EXISTS "org_models_provider_key_id_org_system_provider_keys_id_fk";
--> statement-breakpoint

ALTER TABLE "org_models" RENAME COLUMN "provider_key_id" TO "credential_id";
--> statement-breakpoint

ALTER TABLE "org_models"
  ADD CONSTRAINT "org_models_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "model_provider_credentials"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

DROP TABLE IF EXISTS "org_system_provider_keys";
--> statement-breakpoint

-- 3. Rename `org_models.api` → `api_shape` for naming consistency with
--    the registry's `apiShape` field.
ALTER TABLE "org_models" RENAME COLUMN "api" TO "api_shape";
--> statement-breakpoint

-- 4. Per-run credential pin — runs.model_credential_id gates the OAuth
--    token resolver so a leaked run token can only fetch tokens for the
--    credential the run was launched with. Nullable + ON DELETE SET NULL:
--    credential deletion must not cascade-delete historical run rows.
ALTER TABLE "runs" ADD COLUMN "model_credential_id" uuid;
--> statement-breakpoint

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_model_credential_id_model_provider_credentials_id_fk"
  FOREIGN KEY ("model_credential_id") REFERENCES "model_provider_credentials"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
