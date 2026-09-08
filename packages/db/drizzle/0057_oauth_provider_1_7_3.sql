-- Realign the OAuth-provider tables with the schema `@better-auth/oauth-provider`
-- 1.7.3 declares. From 1.7.3 the drizzle adapter registers a SCHEMA CHECK: it
-- introspects the drizzle schema object at boot and again on the first auth
-- request, and every field the provider writes must exist as a column. A missing
-- one is not a latent bug — it makes `SchemaMismatchError` reject the auth
-- requests, so the shape below is a hard requirement, not a nicety.
--
-- Three groups, one file because they are one contract:
--
--   A. `oauth_clients` gains nine columns and loses two.
--   B. The token / consent tables gain the columns 1.7 writes.
--   C. Three new tables: protected resources (RFC 8707), the client↔resource
--      join, and the `private_key_jwt` assertion replay guard.
--
-- WHY `public` AND `type` GO. Upstream removed both. "Public client" is no
-- longer a stored boolean — it IS `token_endpoint_auth_method = 'none'`, which
-- is what the provider reads to demand PKCE — and `type` was renamed
-- `application_type`. Keeping either as an alias would be a second source of
-- truth for a fact the provider derives (`docs/NO_TRANSITIONAL_CODE.md` §1), so
-- they are dropped, and section D folds their values into the survivors first.
--
-- THE TWO `UPDATE`s IN SECTION D ARE FOLDS, licenced by the `DROP COLUMN` that
-- follows them on the same table (`docs/NO_TRANSITIONAL_CODE.md` §2): the drop
-- destroys the values, so an operator script run afterwards would have nothing
-- left to read. Both are bounded to rows where the target is still empty, so a
-- value written deliberately is never overwritten.
--
-- ROLLBACK: section D is one-way. The previous build writes `public` and `type`
-- on every client it inserts (`services/oauth-admin.ts`,
-- `services/ensure-cli-client.ts`), so redeploying it after this ran makes every
-- client insert fail on 42703. Roll forward.
--
-- FENCES, same instrument as 0039/0047/0055/0056. Everything here is catalog-only
-- or a create-on-empty-table except section D, which scans `oauth_clients` — a
-- table counted in the hundreds on the largest install. On expiry the statement
-- errors, the batch aborts and boot fails its health gate: a failed deploy, not
-- a silent skip.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

-- ═══ A. `oauth_clients` gains the 1.7 registration metadata ══════════════════
--
-- All nullable (or defaulted), all written only by the provider's own
-- registration paths — no platform code sets them, and no existing row needs a
-- value. `IF NOT EXISTS` so a partially-applied environment converges (0041).
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "client_discovery_id" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "client_credentials_scopes" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "backchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "backchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "application_type" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "jwks" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "jwks_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "dpop_bound_access_tokens" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "reference_id" text;--> statement-breakpoint

-- ═══ B. Tokens, consents and the JWK set ═════════════════════════════════════
--
-- `revoked` is a TIMESTAMP, not a flag: introspection tells "never issued" from
-- "revoked at T", and the row survives until it expires. `authorization_code_id`
-- is the join a code replay revokes through: the provider deletes by it on BOTH
-- token tables, hence both indexes.
ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "revoked" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "rotation_replay_response" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "rotation_replay_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "alg" text;--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "crv" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_auth_code" ON "oauth_access_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_refresh_tokens_auth_code" ON "oauth_refresh_tokens" USING btree ("authorization_code_id");--> statement-breakpoint

-- ═══ C. Protected resources, their client links, and the assertion guard ═════
--
-- The platform configures no resource, so all three tables start empty and stay
-- empty until an operator declares one; they exist because the provider reads
-- them on every token mint.
--
-- Both foreign keys are NAMED. Drizzle's derived name for the resource one is 64
-- bytes, one past Postgres' NAMEDATALEN-1 limit: it would be truncated at
-- creation with no warning, and the first `DROP CONSTRAINT` written against the
-- declared name would 42704 and abort the whole pending batch — the beta.24
-- failure mode 0055 was written to close.
--
-- `oauth_client_resources.resource_id` references `oauth_resources.identifier`
-- — the RFC 8707 `resource` value clients actually send — not the surrogate
-- `id`, so a resource can be re-keyed without touching its links. The unique
-- pair is load-bearing: the per-client linkage check assumes one row per pair,
-- and a concurrent duplicate insert is MEANT to raise 23505 so the endpoint can
-- answer "already linked".
CREATE TABLE IF NOT EXISTS "oauth_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resources_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_client_resources_client_id_fk'
      AND conrelid = 'public.oauth_client_resources'::regclass
  ) THEN
    ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_client_resources_resource_id_fk'
      AND conrelid = 'public.oauth_client_resources'::regclass
  ) THEN
    ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resources"("identifier") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_client_resources_client" ON "oauth_client_resources" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_client_resources_resource" ON "oauth_client_resources" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_oauth_client_resources_pair" ON "oauth_client_resources" USING btree ("client_id","resource_id");--> statement-breakpoint

-- ═══ D. Fold `type` and `public` into their survivors, then drop them ════════
--
-- Both `WHERE`s are exactly the condition they remove — a target still empty
-- next to a source that holds the answer — so a second run matches zero rows
-- and neither statement can overwrite a value someone set on purpose.
--
-- `public` maps to an AUTH METHOD, not to a copy: `true` is the public client
-- (`none`), `false` is the confidential one the platform creates with a hashed
-- secret (`client_secret_basic`). Every insert path in this repo already writes
-- `token_endpoint_auth_method`, so on a database with no self-registered client
-- this rewrites nothing — it is here for rows the provider's own DCR path
-- inserted under 1.6, which set `public` alone.
UPDATE oauth_clients SET application_type = "type" WHERE application_type IS NULL AND "type" IS NOT NULL;--> statement-breakpoint
UPDATE oauth_clients SET token_endpoint_auth_method = CASE WHEN "public" THEN 'none' ELSE 'client_secret_basic' END WHERE token_endpoint_auth_method IS NULL AND "public" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" DROP COLUMN IF EXISTS "public";--> statement-breakpoint
ALTER TABLE "oauth_clients" DROP COLUMN IF EXISTS "type";--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
