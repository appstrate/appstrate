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
-- value by the process's UTC offset: measured at 2h on a UTC+2 host and 9h
-- under `TZ=Asia/Tokyo`. A `timestamptz` column round-trips the instant instead
-- of the wall clock, and the shift disappears — that is the whole fix.
--
-- No `TZ` is pinned anywhere: not in `Dockerfile`, not in `docker-compose.yml`,
-- not in `docker-entrypoint.sh`. The offset is whatever the host gives the
-- container, so the size of the bug is a deployment detail nobody chose.
--
-- Three of these columns are security-relevant expiries compared in JS, not in
-- SQL, which is what turns a display skew into an auth defect — five call sites
-- between them:
--
--   device_codes.expires_at         modules/oidc/services/cli-tokens.ts:231
--   device_codes.expires_at         modules/oidc/routes.ts:2192
--   cli_refresh_tokens.expires_at   modules/oidc/services/cli-tokens.ts:452
--   cli_refresh_tokens.expires_at   modules/oidc/services/cli-tokens.ts:839
--   webhooks.secret_next_expires_at modules/webhooks/service.ts:640
--
-- all of the shape `row.expiresAt < new Date()`. East of UTC the value read
-- back is EARLIER than the instant that was written — under `TZ=Asia/Tokyo`,
-- `new Date("2026-08-25 14:03:00").toISOString()` is `2026-08-25T05:03:00Z`,
-- nine hours early — so the comparison fires early: at UTC+9 a device code with
-- a 10-minute TTL is born already expired and CLI login is 100% broken. West of
-- UTC it fires late: at UTC−5 a refresh token and every access token minted
-- from it live five hours past their issued lifetime.
-- `webhooks.secret_next_expires_at` gates the dual-signature rotation window
-- the same way — east, the old secret is retired before consumers have rotated.
--
-- ═══ TWO WRITER POPULATIONS, AND WHAT `USING` ASSERTS ABOUT EACH ═══
--
-- `USING col AT TIME ZONE 'UTC'` reads each stored naive value AS a UTC wall
-- clock. Whether that is true depends on WHO wrote the row, and these 30
-- columns have two writers, not one.
--
--   APPLICATION-WRITTEN. postgres.js sends a JS `Date` as `.toISOString()`, a
--   UTC wall clock by construction. For those rows the assertion holds on any
--   server, whatever its `TimeZone`, and no row moves.
--
--   DB-DEFAULT-WRITTEN. 17 of the 30 carry `DEFAULT now()` — counted column by
--   column against `meta/0046_snapshot.json`, the catalog this file starts
--   from, and the same 17 the `SET DEFAULT` statements below re-declare.
--   `now()` is `timestamptz`; storing it in a naive column casts it down, and
--   `now()::timestamp` renders in the SERVER's `TimeZone` GUC — not in UTC. For
--   `webhooks` and `webhook_deliveries` that default is the ONLY insert writer:
--   `modules/webhooks/service.ts:268` (webhooks) and `:713`/`:744` (deliveries)
--   omit the timestamp columns from their `values(...)` object entirely, and
--   the drizzle columns carry `defaultNow()` with no `$onUpdateFn`
--   (`src/schema/webhooks.ts:56-57,90`). On a non-UTC server those rows hold
--   LOCAL wall clocks, and `AT TIME ZONE 'UTC'` moves them by the server's
--   offset — permanently, with no record of the original instant to undo it
--   from.
--
-- Reproduced rather than argued, in a throwaway PGlite with
-- `SET TimeZone='Europe/Paris'`: a row inserted through `DEFAULT now()` at true
-- instant `19:50:30Z` is stored naive as `21:50:30`, and after the conversion
-- below its instant reads `21:50:30Z` — two hours late, forever. A row written
-- by the application into the same column of the same table converted
-- correctly in the same run. The two populations genuinely diverge.
--
-- `webhooks.updated_at` carries BOTH conventions in one column: `DEFAULT now()`
-- on INSERT, `new Date()` from `service.ts:457` and `:651` on UPDATE. On a
-- non-UTC server no single `USING` clause is correct for it.
--
-- Dropping the `USING` clause would be worse, not better: the plain form
-- interprets every value in the server's `TimeZone`, which is wrong for the
-- application-written majority instead of for the default-written minority.
-- There is no expression that is right for both populations on a non-UTC
-- server, so this file asserts UTC — and then CHECKS the assertion.
--
-- ═══ THE UTC GUARD ═══
--
-- The first statement below refuses to run this migration when the server does
-- not render `now()` in UTC AND at least one of the eleven tables holding a
-- `DEFAULT now()` column already has rows.
--
-- It measures the property directly — the offset between a wall clock rendered
-- in the session's `TimeZone` and the same instant rendered in UTC — rather
-- than matching the GUC's NAME against a list, because the name is not a
-- reliable spelling of the offset. PGlite (tiers 0-1) derives its `TimeZone`
-- from the host and reports it as a fixed offset zone: `Etc/GMT0` for a UTC
-- host, `Etc/GMT-1` for `Europe/Paris`, `Etc/GMT-9` for `Asia/Tokyo`,
-- `Etc/GMT+5` for `America/New_York` (measured, PGlite 0.5.4). An allowlist of
-- `('UTC','Etc/UTC')` would therefore reject every PGlite install including the
-- correctly-configured ones; the offset test accepts `Etc/GMT0` and rejects the
-- other three.
--
-- IT PROBES TWO INSTANTS OF THE CURRENT YEAR, AND BOTH HALVES OF THAT SENTENCE
-- ARE LOAD-BEARING. A zone's offset is a function of two variables — WHERE in
-- the year you look, and WHICH year's rules you look under — and getting either
-- one wrong turns the guard into a coin flip that reads as a pass.
--
-- THE SEASONAL AXIS. Reading the offset at `now()` — the shape this guard
-- shipped with — makes the verdict depend on the CALENDAR rather than on the
-- zone. `Europe/London`,
-- `Europe/Dublin`, `Europe/Lisbon` and `Atlantic/Canary` sit at +00:00 from
-- late October to late March and +01:00 the rest of the year. A deploy in
-- January measures `00:00:00`, returns early, and lets all 30 conversions run
-- with the guard having asserted NOTHING — while the rows written during BST,
-- stored an hour ahead of UTC, are re-read as UTC and moved permanently late,
-- with nothing left to reconstruct them from. The mirror case is a spurious
-- refusal: the same server in July measures `01:00:00` and refuses a database
-- where every row is fine. Same server, same data, opposite verdict decided by
-- the month.
--
-- THE HISTORICAL AXIS, which is the same defect reached through a different
-- door. Probing two seasons closes the first one — but only for the year the
-- probes are pinned to. `AT TIME ZONE` resolves against the zone's rules AS OF
-- THE INSTANT PROBED, so a probe hardcoded to, say, year 2000 asks what the
-- zone did in 2000, which is not what it does at deploy time. Zones are
-- political and they change: `Africa/Casablanca` was UTC+0 year-round until
-- 2008, ran seasonal DST through the 2010s, and has been permanently UTC+1
-- since 2018. Probed at 2000 it reads 00:00:00 on BOTH sides, returns early,
-- and lets all 30 conversions run on a server that is an hour off today —
-- character for character the same silent corruption, just reached from the
-- other axis. (Measured in PGlite: Casablanca reads 00:00:00/00:00:00 at year
-- 2000 and 01:00:00/01:00:00 at the current year.)
--
-- So the guard derives the probe YEAR from `now()` and builds a mid-WINTER and
-- a mid-SUMMER instant inside it, returning early only if BOTH read zero. What
-- comes from the clock is the year to ask about; the offset itself is never
-- read at `now()`. A zone that observes DST fails closed all year round instead
-- of flipping, a zone whose rules changed is judged on its CURRENT rules, and a
-- genuinely fixed zero-offset zone (`UTC`, `Etc/UTC`, PGlite's `Etc/GMT0`)
-- reads zero at both probes in every year and passes.
--
-- The row condition is what keeps the guard from being a blanket ban on non-UTC
-- development machines. A fresh install replays 0000-0052 in one batch with
-- these eleven tables empty, so there is nothing for the conversion to move and
-- the guard is a no-op whatever the host's zone. It fires only where data that
-- would actually be moved already exists.
--
-- On the deployment this repo ships — `postgres:16-alpine`, which every compose
-- file declares and which runs UTC unless configured otherwise — the guard is a
-- no-op on both counts. Where it does fire it converts a silent, irreversible
-- shift of stored instants into a failed deploy that names the offset and the
-- populated tables: the same trade the `lock_timeout` fence already makes below.
--
-- WHAT IT DOES NOT PROVE. It reads the zone as configured NOW; the rows were
-- written under whatever zone was configured THEN. Probing two instants closes
-- the calendar hole, not this one — no expression can recover a write-time
-- offset the schema never recorded.
-- A server since switched to UTC passes the guard while its older
-- `DEFAULT now()` rows stay skewed, and setting `TimeZone` to UTC in response
-- to the error silences the check without correcting one row. The error message
-- says exactly that. Proving the write-time offset would need a record this
-- schema does not keep.
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
-- THE THRESHOLD, because a query with no number attached is not a pre-flight:
-- 1 GiB of total relation size on any one of them. Above that, do not ship this
-- migration — prune `webhook_deliveries` first, since nothing else will. The
-- number is a policy this file picks, not a measurement. What IS established is
-- the shape of the cost: the rewrite must read and write the entire heap and
-- rebuild every index on it, and nothing in the deploy path bounds how long
-- that takes.
--
-- `lock_timeout` does not bound it. It bounds ACQUISITION — how long a
-- statement waits for a lock it cannot get — so a rewrite that takes its lock
-- in a millisecond and then runs for twenty minutes never trips it. That is why
-- a second fence sits beside it: `SET LOCAL statement_timeout = '60s'` bounds
-- EXECUTION, turning an unbounded outage of the webhook path into a failed
-- deploy after a minute.
--
-- Neither fence bounds the HOLD. Locks are held to COMMIT, and drizzle's pg
-- dialect wraps the WHOLE pending batch in ONE `session.transaction(...)`, so
-- every table touched here stays locked until the last migration in the batch
-- commits — not just until its own statement finishes. The outage is the sum of
-- the batch; `statement_timeout` caps each addend, and the size threshold above
-- is what keeps the sum from mattering. Taken literally the cap allows
-- 47 × 60s for this file alone, which would be a useless bound if it were
-- reachable — under the threshold it is not, and the cap can only bind on a
-- table nobody expected to be large, which is precisely when the deploy should
-- stop.
--
-- Both fences are `SET LOCAL`, and both are reset to DEFAULT at the end — see
-- 0039's header for why `SET LOCAL` rather than `SET` (a plain `SET` survives
-- COMMIT onto the pooled connection, and either form would otherwise bleed into
-- 0048+ running later in the same transaction).
--
-- The cost on expiry of either fence, written down rather than discovered: the
-- statement errors and aborts the single transaction wrapping the batch —
-- `migrate` throws, boot fails, the deploy fails its health gate. That is the
-- right trade (fail fast, retry) but it is a failed deploy, not a silent skip.
-- The 3s lock budget is per STATEMENT, not for the file: the 47 `ALTER`
-- statements below each wait up to 3s for their lock.
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
-- ═══ WHY TESTS SHIP WITH IT ═══
--
-- `packages/db/test/schema-timestamptz.test.ts` asserts that no bare
-- `timestamp(` survives in `src/schema/`. Without it the next table folded in
-- from a module repeats this exactly — which is how these 30 got here.
--
-- `packages/db/test/migration-0047-utc-guard.test.ts` extracts the guard block
-- from THIS file and replays it against a throwaway in-memory PGlite under
-- seven conditions — zero offset with rows present, non-zero offset with the
-- tables empty, non-zero offset with a row present, `Europe/London` (the
-- seasonal hole, where a one-instant probe reads zero all winter) both empty
-- and populated, `Africa/Casablanca` (the historical hole, where a probe pinned
-- to year 2000 reads zero on both sides) populated, and `Etc/GMT0` populated as
-- the control that neither correction became a blanket ban. It reads the
-- shipped text rather than a copy of it, so the guard cannot be weakened here
-- and stay green there.
--
-- No index, primary key or check constraint references any of these 30 columns
-- (verified against `meta/0046_snapshot.json`), and the schema declares no
-- views, so nothing outside the twelve tables has to be dropped and recreated.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
DO $$
DECLARE
  server_tz text := current_setting('TimeZone');
  -- Two probes, one per side of the DST year, in the year the deploy is
  -- happening. Both axes matter and both have bitten this guard:
  --
  --   SEASONAL — probing a single instant (`now()`) reads 00:00:00 on
  --   Europe/London every winter and 01:00:00 every summer, so the verdict
  --   would depend on the deploy DATE rather than on the zone.
  --
  --   HISTORICAL — pinning the probes to a hardcoded year reads that year's
  --   RULES, not today's. Africa/Casablanca was UTC+0 year-round until 2008 and
  --   has been permanently UTC+1 since 2018: probed at year 2000 it reads zero
  --   on both sides and waves the conversion through on a server that is an
  --   hour off today.
  --
  -- Hence `extract(year from now())` — the YEAR comes from the clock, the
  -- OFFSET never does. Both must be zero for `AT TIME ZONE 'UTC'` to be correct
  -- for the `DEFAULT now()` population.
  probe_year int := extract(year from now())::int;
  winter_probe timestamptz := make_timestamptz(probe_year, 1, 15, 12, 0, 0, 'UTC');
  summer_probe timestamptz := make_timestamptz(probe_year, 7, 15, 12, 0, 0, 'UTC');
  winter_offset interval :=
    (winter_probe AT TIME ZONE server_tz) - (winter_probe AT TIME ZONE 'UTC');
  summer_offset interval :=
    (summer_probe AT TIME ZONE server_tz) - (summer_probe AT TIME ZONE 'UTC');
  candidate text;
  has_rows boolean;
  populated text[] := ARRAY[]::text[];
BEGIN
  -- Zero on BOTH sides of the DST year: the zone is a genuine fixed UTC, so
  -- `now()::timestamp` always rendered in UTC and the `USING` clause below is
  -- correct for BOTH writer populations. Nothing to check.
  IF winter_offset = interval '0' AND summer_offset = interval '0' THEN
    RETURN;
  END IF;

  -- Non-zero on at least one side. Only rows already written through such an
  -- offset can be moved, so the
  -- eleven tables carrying a `DEFAULT now()` column decide whether this is a
  -- real hazard or an empty fresh install.
  FOREACH candidate IN ARRAY ARRAY[
    'application_smtp_configs', 'application_social_providers', 'cli_refresh_tokens',
    'jwks', 'oauth_access_tokens', 'oauth_clients', 'oauth_consents',
    'oauth_refresh_tokens', 'oidc_end_user_profiles', 'webhook_deliveries', 'webhooks'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', candidate) INTO has_rows;
    IF has_rows THEN
      populated := populated || candidate;
    END IF;
  END LOOP;

  IF cardinality(populated) = 0 THEN
    RETURN;
  END IF;

  RAISE EXCEPTION
    'migration 0047 refuses to convert: server TimeZone is %, which in % renders now() % from UTC in winter and % in summer, and these tables already hold rows: %',
    server_tz, probe_year, winter_offset, summer_offset, array_to_string(populated, ', ')
    USING
      DETAIL =
        'The 17 DEFAULT now() columns this migration converts were written through that offset, '
        'so USING ... AT TIME ZONE ''UTC'' would shift those instants by it, irreversibly.',
      HINT =
        'postgres:16-alpine runs UTC; a non-UTC reading means it was configured that way. '
        'A zone that is UTC for only part of the year (Europe/London, Europe/Dublin, '
        'Europe/Lisbon, Atlantic/Canary) is refused all year round on purpose: its DEFAULT '
        'now() rows are skewed for the other half, whichever half the deploy lands in. '
        'Recreate the database if this data is disposable (a local PGlite or dev database), '
        'or correct the affected rows before re-running. Switching TimeZone to UTC now only '
        'silences this check - it does not move a single stored row back.';
END $$;--> statement-breakpoint
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
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
