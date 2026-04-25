-- Unified LLM cost ledger — one row per attributable LLM call, regardless
-- of how it reached the provider. Two sources share the same schema:
--
--   * source = 'proxy'  → inserted by `/api/llm-proxy/*` routes; dedup on
--                         `request_id` (the proxy mints one per upstream
--                         call so CLI retries are no-ops).
--   * source = 'runner' → inserted by the run event sink when an
--                         `appstrate.metric` event arrives; dedup on
--                         `(run_id, sequence)` via the AFPS sink protocol's
--                         monotonic event sequence.
--
-- `runs.cost` is the cached SUM of this table for the run. It is written
-- exactly once by `finalizeRun` and must never be mutated from anywhere
-- else. (`credential_proxy_usage` is an audit log — see its header
-- comment in the schema. Today every row carries cost_usd = 0 and is
-- intentionally not summed into `runs.cost`. When the first metered
-- credential provider ships, route its rows through this table with a
-- new `source` enum value rather than resurrecting a cross-table SUM.)

DO $$ BEGIN
  CREATE TYPE "llm_usage_source" AS ENUM ('proxy', 'runner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "source" "llm_usage_source" NOT NULL,
  "org_id" uuid NOT NULL,
  "api_key_id" text,
  "user_id" text,
  "run_id" text,
  "model" text,
  "real_model" text,
  "api" text,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cache_read_tokens" integer,
  "cache_write_tokens" integer,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "duration_ms" integer,
  "request_id" text,
  "sequence" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  -- At INSERT time the service sets exactly one of api_key_id / user_id;
  -- both may go NULL later when the referenced principal is deleted
  -- (FK ON DELETE SET NULL), so this check is permissive on the "both
  -- null" cleanup case but rejects rows that try to claim both principals.
  CONSTRAINT "llm_usage_principal_single"
    CHECK (api_key_id IS NULL OR user_id IS NULL),
  -- Source-consistency invariants: each source carries its own dedup key.
  CONSTRAINT "llm_usage_proxy_has_request_id"
    CHECK (source <> 'proxy' OR request_id IS NOT NULL),
  CONSTRAINT "llm_usage_runner_has_sequence"
    CHECK (source <> 'runner' OR (run_id IS NOT NULL AND sequence IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_usage"
    ADD CONSTRAINT "llm_usage_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_usage"
    ADD CONSTRAINT "llm_usage_api_key_id_api_keys_id_fk"
    FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_usage"
    ADD CONSTRAINT "llm_usage_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "llm_usage"
    ADD CONSTRAINT "llm_usage_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_org_id" ON "llm_usage" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_api_key_id" ON "llm_usage" ("api_key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_user_id" ON "llm_usage" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_run_id" ON "llm_usage" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_org_created" ON "llm_usage" ("org_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_llm_usage_proxy_request_id"
  ON "llm_usage" ("request_id")
  WHERE source = 'proxy' AND request_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_llm_usage_runner_run_sequence"
  ON "llm_usage" ("run_id", "sequence")
  WHERE source = 'runner' AND run_id IS NOT NULL AND sequence IS NOT NULL;
