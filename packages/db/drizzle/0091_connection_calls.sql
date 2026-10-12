-- 0091 — the credential proxy's call journal: one row per call that may have sent a connection's
-- credential. No foreign keys, like `audit_events`: the journal outlives the organization, space,
-- connection, run and key it names. `host` and `path` are the caller's target before
-- substitution, without its query string. The two composite indexes serve the reads' `id DESC`
-- paging: a space's calls, and one connection's.
CREATE TABLE "connection_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"integration_id" text NOT NULL,
	"owner_type" text,
	"owner_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"api_key_id" text,
	"auth_method" text NOT NULL,
	"run_id" text,
	"method" text NOT NULL,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_connection_calls_space_id" ON "connection_calls" USING btree ("space_id","id");--> statement-breakpoint
CREATE INDEX "idx_connection_calls_connection_id" ON "connection_calls" USING btree ("connection_id","id");--> statement-breakpoint
CREATE INDEX "idx_connection_calls_run" ON "connection_calls" USING btree ("run_id");
