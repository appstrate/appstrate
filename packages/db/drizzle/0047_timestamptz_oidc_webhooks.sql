-- Convert the last 30 `timestamp without time zone` columns to `timestamptz`.
--
-- 83 of the schema's 113 timestamp columns are already `timestamptz`. These 30
-- are the folded-in module tables that never got the treatment: 26 across the
-- ten OIDC tables (`src/schema/oidc.ts`) and 4 across the two webhook tables
-- (`src/schema/webhooks.ts`). They are a minority left behind by a fold, not a
-- deliberate exception — nothing reads them as naive local times.
--
-- ═══ WHY THIS IS A BUG AND NOT A STYLE PREFERENCE ═══
--
-- postgres.js serialises a JS `Date` with `.toISOString()` — a UTC wall clock
-- with a trailing `Z`. Sent to a naive column, the `Z` is discarded and the UTC
-- wall clock is stored verbatim. On the way back the driver hands JS the
-- space-separated form `2026-08-25 14:03:00`, and `new Date(x)` on that form is
-- parsed by V8 as LOCAL time. Every write→read round trip therefore shifts the
-- value by the process's UTC offset: measured at +2h on a UTC+2 host and +9h
-- under `TZ=Asia/Tokyo`. A `timestamptz` column round-trips the instant instead
-- of the wall clock, and the shift disappears — that is the whole fix.
--
-- No `TZ` is pinned anywhere: not in `Dockerfile`, not in `docker-compose.yml`,
-- not in `docker-entrypoint.sh`. The offset is whatever the host gives the
-- container, so the size of the bug is a deployment detail nobody chose.
--
-- Five of these columns are security-relevant expiries compared in JS, not in
-- SQL, which is what turns a display skew into an auth defect:
--
--   device_codes.expires_at         modules/oidc/services/cli-tokens.ts:231
--   cli_refresh_tokens.expires_at   modules/oidc/services/cli-tokens.ts:452
--   cli_refresh_tokens.expires_at   modules/oidc/services/cli-tokens.ts:839
--   webhooks.secret_next_expires_at modules/webhooks/service.ts:640
--
-- all of the shape `row.expiresAt < new Date()`. East of UTC the stored value
-- reads LATER than it was written, so the comparison fires early: at UTC+9 a
-- device code with a 10-minute TTL is born already expired and CLI login is
-- 100% broken. West of UTC it fires late: at UTC−5 a refresh token and every
-- access token minted from it live five hours past their issued lifetime.
-- `webhooks.secret_next_expires_at` gates the dual-signature rotation window
-- the same way — east, the old secret is retired before consumers have rotated.
--
-- ═══ WHAT THE `USING` CLAUSE ASSERTS ═══
--
-- `USING col AT TIME ZONE 'UTC'` reads each stored naive value AS a UTC wall
-- clock. That is exactly what the driver put there (`.toISOString()`), so the
-- instant every row was written at is preserved and no row moves. The plain
-- form without `USING` would interpret the values in the SERVER's `TimeZone`
-- GUC instead — correct only by luck, and silently wrong on any server not set
-- to UTC. Being explicit costs a rewrite (below) and buys determinism.
--
-- ═══ WHY THE DEFAULTS ARE RE-DECLARED ═══
--
-- The 17 `SET DEFAULT now()` statements are not redundant. `ALTER COLUMN TYPE`
-- keeps the existing default by coercing it THROUGH the old type: a column that
-- reads `DEFAULT now()` today has `now()` stored already cast down to
-- `timestamp`, and after the type change the catalog holds the double
-- conversion `now()::timestamp::timestamptz`. That is runtime-identical while
-- the session time zone is stable, so nothing breaks — but the catalog then
-- disagrees with what the snapshot declares (`now()`), and the next
-- `db:generate` diff inherits a phantom change nobody made. Re-declaring the
-- default is a catalog-only write; it costs nothing and removes the trap.
--
-- ═══ LOCK AND COST ═══
--
-- `ALTER COLUMN … TYPE` with an explicit `USING` expression takes ACCESS
-- EXCLUSIVE on the table and ALWAYS rewrites it — new heap, indexes rebuilt.
-- ACCESS EXCLUSIVE conflicts with every other lock mode, readers included, and
-- the request queues AHEAD of everything behind it on that table. The twelve
-- tables here are OIDC session/token state and webhook bookkeeping — small and
-- churn-heavy, not `runs`-scale — with `webhook_deliveries` (append-only, no
-- retention sweep) the one that grows unbounded and therefore the one worth
-- checking before a deploy:
--
--   SELECT relname, pg_size_pretty(pg_total_relation_size(oid)), reltuples::bigint
--   FROM pg_class WHERE relname IN ('webhook_deliveries','oauth_access_tokens',
--     'oauth_refresh_tokens','cli_refresh_tokens','device_codes');
--
-- Locks are held to COMMIT, and drizzle's pg dialect wraps the WHOLE pending
-- batch in ONE `session.transaction(...)`, so every table touched here stays
-- locked until the last migration in the batch commits — not just until its own
-- statement finishes.
--
-- Hence the `SET LOCAL lock_timeout = '3s'` fence, reset to DEFAULT after —
-- same instrument as 0039 and 0041; see 0039's header for `SET LOCAL` rather
-- than `SET`, and for why the reset matters (a plain `SET` survives COMMIT onto
-- the pooled connection, and either form would bleed into 0048+ running later
-- in the same transaction).
--
-- The cost on expiry, written down rather than discovered: the statement errors
-- and aborts the single transaction wrapping the batch — `migrate` throws, boot
-- fails, the deploy fails its health gate. That is the right trade (fail fast,
-- retry) but it is a failed deploy, not a silent skip. The 3s budget is per
-- STATEMENT, not for the file: 47 statements each wait up to 3s for their lock.
--
-- ═══ NOT GUARDED WITH `IF EXISTS`, DELIBERATELY ═══
--
-- Unlike 0039/0041 there is no divergent-population problem to absorb. Every
-- database — pre-squash production and every fresh install alike — has all 30
-- columns as `timestamp`; there is no environment where a statement here is
-- already the end state. Re-running a `SET DATA TYPE` that is already applied
-- is a no-op anyway (`timestamptz AT TIME ZONE 'UTC'` yields `timestamp`, so a
-- second pass would MOVE the values — which is precisely why this file must run
-- exactly once, and drizzle's journal is what guarantees that).
--
-- ═══ WHY A TEST SHIPS WITH IT ═══
--
-- `packages/db/test/schema-timestamptz.test.ts` asserts that no bare
-- `timestamp(` survives in `src/schema/`. Without it the next table folded in
-- from a module repeats this exactly — which is how these 30 got here.
--
-- No index, primary key or check constraint references any of these 30 columns
-- (verified against `meta/0046_snapshot.json`), and the schema declares no
-- views, so nothing outside the twelve tables has to be dropped and recreated.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "application_smtp_configs" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "application_smtp_configs" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "application_smtp_configs" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "application_smtp_configs" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "application_social_providers" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "application_social_providers" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "application_social_providers" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "application_social_providers" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ALTER COLUMN "used_at" SET DATA TYPE timestamp with time zone USING "used_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE timestamp with time zone USING "revoked_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ALTER COLUMN "last_used_at" SET DATA TYPE timestamp with time zone USING "last_used_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "device_codes" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "device_codes" ALTER COLUMN "last_polled_at" SET DATA TYPE timestamp with time zone USING "last_polled_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "jwks" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "jwks" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "jwks" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oauth_consents" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_consents" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_consents" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oauth_consents" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "revoked" SET DATA TYPE timestamp with time zone USING "revoked" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "auth_time" SET DATA TYPE timestamp with time zone USING "auth_time" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "secret_next_expires_at" SET DATA TYPE timestamp with time zone USING "secret_next_expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;