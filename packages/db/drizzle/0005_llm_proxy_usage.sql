-- Per-call metering of the `/api/llm-proxy/*` routes.
--
-- One row per upstream LLM request the platform proxied server-side for
-- a remote runner (CLI, GitHub Action, third-party agents). Exactly one
-- of `api_key_id` / `user_id` is populated so accounting can never
-- double-count a request — enforced by the `principal_xor` CHECK.
--
-- `run_id` is nullable because Phase 3 ships standalone proxy calls
-- (`X-Run-Id` absent). Phase 4's `POST /api/runs/remote` path will
-- propagate the header and populate the column without migration.

CREATE TABLE IF NOT EXISTS "llm_proxy_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "api_key_id" text,
  "user_id" text,
  "run_id" text,
  "model" text NOT NULL,
  "real_model" text NOT NULL,
  "api" text NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cache_read_tokens" integer,
  "cache_write_tokens" integer,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "duration_ms" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  -- At INSERT time the service sets exactly one of api_key_id / user_id;
  -- both may go NULL later when the referenced principal is deleted
  -- (FK ON DELETE SET NULL), so this check is permissive on the "both
  -- null" cleanup case but rejects rows that try to claim both principals.
  CONSTRAINT "llm_proxy_usage_principal_single"
    CHECK (api_key_id IS NULL OR user_id IS NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_proxy_usage"
    ADD CONSTRAINT "llm_proxy_usage_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_proxy_usage"
    ADD CONSTRAINT "llm_proxy_usage_api_key_id_api_keys_id_fk"
    FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_proxy_usage"
    ADD CONSTRAINT "llm_proxy_usage_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_proxy_usage"
    ADD CONSTRAINT "llm_proxy_usage_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_proxy_usage_org_id" ON "llm_proxy_usage" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_proxy_usage_api_key_id" ON "llm_proxy_usage" ("api_key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_proxy_usage_user_id" ON "llm_proxy_usage" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_proxy_usage_run_id" ON "llm_proxy_usage" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_proxy_usage_org_created" ON "llm_proxy_usage" ("org_id", "created_at");
