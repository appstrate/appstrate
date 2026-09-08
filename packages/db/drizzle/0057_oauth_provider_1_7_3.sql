-- Realign the OAuth-provider tables with the schema `@better-auth/oauth-provider`
-- 1.7.3 declares. Four groups, one file because they are one contract:
--
--   A. `oauth_clients` gains nine columns and loses two.
--   B. The token / consent tables gain the columns the provider writes.
--   C. Three new tables: protected resources (RFC 8707), the client↔resource
--      join, and the `private_key_jwt` assertion replay guard.
--   D. The two folds, then the drops.
--   E. `self_service` moves from the provider-owned `metadata` JSON to a
--      platform-owned column.
--
-- ORDER OF APPLICATION. `applyCoreMigrations()` runs before `createAuth()`
-- inside `bootCritical()` (`apps/api/src/lib/boot.ts`), so a process that serves
-- an auth request has already applied this file. The drizzle adapter's schema
-- check is not what orders it: `introspectDrizzleSchema` reads the TYPESCRIPT
-- drizzle objects through `getTableColumns()` and diffs them against the fields
-- the plugin declares (missing table / missing column / unexpected required
-- column). It never queries Postgres, so it cannot observe this file either way
-- — it runs once at boot, where a failure is only logged, and is awaited on every
-- `/api/auth/**` request, where a failure is rejected and cached until restart.
--
-- WHY `public` AND `type` GO. Upstream's schema declares neither. A public
-- client IS `token_endpoint_auth_method = 'none'`, which is what the provider
-- reads to demand PKCE, and the application type is `application_type`. Keeping
-- either as an alias would be a second source of truth for a fact the provider
-- derives (`docs/NO_TRANSITIONAL_CODE.md` §1), so they are dropped, and section D
-- folds their values into the survivors first.
--
-- THE TWO `UPDATE`s IN SECTION D ARE FOLDS, licenced by the `DROP COLUMN` that
-- follows them on the same table (`docs/NO_TRANSITIONAL_CODE.md` §2): the drop
-- destroys the values, so an operator script run afterwards would have nothing
-- left to read. Both are bounded to rows where the target is still empty, so a
-- value written deliberately is never overwritten.
--
-- DEPLOY. Section D is one-way, and the risk it carries is an OLD replica still
-- serving after the `DROP COLUMN`s: the previous build writes `public` and
-- `type` on every client it inserts (`services/oauth-admin.ts`,
-- `services/ensure-cli-client.ts`), so its inserts fail with 42703 the moment
-- the columns are gone. Roll forward; do not leave both builds live.
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
-- `oauth_resources` is populated, not empty: the plugin seeds the two platform
-- identifiers from its `resources:` option at init (`APP_URL` and
-- `${APP_URL}/api/auth`, `resourceSeedMode` at its `insertOnly` default) and the
-- mcp module writes one row per organization (`modules/mcp/index.ts`). The
-- provider resolves every requested RFC 8707 `resource` against this table on
-- each mint, and the seed runs once per process — truncating the table breaks
-- every mint until a restart.
--
-- `oauth_client_resources` and `oauth_client_assertions` do stay empty:
-- `enforcePerClientResources` is `false`, so no client needs a linkage row, and
-- no client authenticates with `private_key_jwt`.
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
-- Both folds make an IMPLICIT stored value explicit before the source column
-- disappears; neither changes what the provider does with the row.
--
--   `type` → `application_type` is read at registration time only, by
--   `validateClientRedirectUri`, which is where the provider decides whether a
--   redirect URI is acceptable for that application type.
--
--   `public` → `token_endpoint_auth_method` reproduces the runtime default:
--   `validateClientCredentials` (`utils-*.mjs`) reads a NULL method as
--   `client_secret_basic` and then enforces the registered method strictly. The
--   `WHEN "public" THEN 'none'` branch cannot match a provider-written row — the
--   provider derived `public` FROM the method — and every insert path in this
--   repo already writes `token_endpoint_auth_method`, so on most databases this
--   rewrites nothing.
--
-- OPERATOR PRE-FLIGHT, to run BEFORE this migration. A client registered under
-- beta.4 with no method stored authenticated with its secret in the POST body;
-- under 1.7.3 the stored NULL reads as `client_secret_basic` and that client
-- gets `invalid_client`. Count them first:
--
--     SELECT count(*) FROM oauth_clients
--     WHERE token_endpoint_auth_method IS NULL AND "public" = false;
--
-- A non-zero count is a decision to take, not a detail: fold those rows to
-- `client_secret_post` by hand instead, or notify their owners that they must
-- move to `client_secret_basic`.
UPDATE oauth_clients SET application_type = "type" WHERE application_type IS NULL AND "type" IS NOT NULL;--> statement-breakpoint
UPDATE oauth_clients SET token_endpoint_auth_method = CASE WHEN "public" THEN 'none' ELSE 'client_secret_basic' END WHERE token_endpoint_auth_method IS NULL AND "public" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" DROP COLUMN IF EXISTS "public";--> statement-breakpoint
ALTER TABLE "oauth_clients" DROP COLUMN IF EXISTS "type";--> statement-breakpoint
-- ═══ E. `self_service` becomes a column ══════════════════════════════════════
--
-- `/oauth2/token` confines a self-registered client's tokens to one protected
-- resource, and this column is what it reads. The provider owns the `metadata`
-- JSON: an RFC 7591 registration body may set it, and the provider persists
-- what the client presented, so a flag kept there is one a client can name.
-- Nothing reaches this column but the platform.
--
-- The `UPDATE` folds the JSON key `selfService` into the column in the file
-- that removes its last reader; without it every already-registered
-- self-service client reads as operator-provisioned and loses that confinement.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "self_service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE oauth_clients SET self_service = true WHERE metadata IS NOT NULL AND metadata::jsonb ->> 'selfService' = 'true';--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
