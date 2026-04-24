-- Unified runner protocol.
--
-- Every run — platform container or remote CLI — posts events to
-- POST /api/runs/:id/events over HMAC-signed HTTP. The `runs` row is the
-- per-run credential store and sink lifecycle tracker. `run_origin` is an
-- operational attribute (who controls the process); the protocol is the
-- same for both.
--
-- Per-run secret is stored AES-256-GCM encrypted (via
-- @appstrate/connect encryption + CONNECTION_ENCRYPTION_KEY). Returned
-- plaintext once at run creation, then lives encrypted at rest.
-- Revocation is `sink_closed_at = now()` (single-run granularity).

ALTER TABLE "runs"
  ADD COLUMN "run_origin" text DEFAULT 'platform' NOT NULL,
  ADD COLUMN "sink_secret_encrypted" text,
  ADD COLUMN "sink_expires_at" timestamp,
  ADD COLUMN "sink_closed_at" timestamp,
  ADD COLUMN "last_event_sequence" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "context_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "runs"
  ADD CONSTRAINT "runs_run_origin_valid"
  CHECK (run_origin IN ('platform', 'remote'));
--> statement-breakpoint
-- An open sink (has an expires_at) must have a stored ciphertext the
-- ingestion middleware can decrypt. Enforced for every origin so the
-- platform and remote paths share identical ingestion code.
ALTER TABLE "runs"
  ADD CONSTRAINT "runs_open_sink_has_secret"
  CHECK (sink_expires_at IS NULL OR sink_secret_encrypted IS NOT NULL);
--> statement-breakpoint
-- Reaper scans only active sinks — cheap partial index.
CREATE INDEX IF NOT EXISTS "idx_runs_sink_expires_at"
  ON "runs" ("sink_expires_at")
  WHERE sink_expires_at IS NOT NULL AND sink_closed_at IS NULL;
--> statement-breakpoint

-- Per-call metering of the /api/credential-proxy/* routes. Mirrors
-- llm_usage so reporting queries compose:
--   SUM(llm_usage.cost_usd) + SUM(credential_proxy_usage.cost_usd)
--   WHERE run_id = $1
-- yields the full attributable spend for one run.
--
-- request_id is the dedup key — the proxy route derives one per upstream
-- request; retries of the same request are no-ops via the UNIQUE constraint.
CREATE TABLE IF NOT EXISTS "credential_proxy_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "api_key_id" text,
  "user_id" text,
  "run_id" text,
  "application_id" text,
  "provider_id" text NOT NULL,
  "target_host" text,
  "http_status" integer,
  "duration_ms" integer,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "request_id" text NOT NULL UNIQUE,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "credential_proxy_usage_principal_single"
    CHECK (api_key_id IS NULL OR user_id IS NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "credential_proxy_usage"
    ADD CONSTRAINT "credential_proxy_usage_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "credential_proxy_usage"
    ADD CONSTRAINT "credential_proxy_usage_api_key_id_api_keys_id_fk"
    FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "credential_proxy_usage"
    ADD CONSTRAINT "credential_proxy_usage_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "credential_proxy_usage"
    ADD CONSTRAINT "credential_proxy_usage_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "credential_proxy_usage"
    ADD CONSTRAINT "credential_proxy_usage_application_id_applications_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credential_proxy_usage_org_id" ON "credential_proxy_usage" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credential_proxy_usage_run_id" ON "credential_proxy_usage" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credential_proxy_usage_org_created" ON "credential_proxy_usage" ("org_id", "created_at");
