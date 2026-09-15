-- 0011 — set `oauth_clients.self_service` from the `metadata` JSON key
-- `selfService`.
--
-- Run AFTER the drizzle batch that carries
-- `packages/db/drizzle/0057_oauth_provider_1_7_3.sql`, on every deployment that
-- has ever accepted a self-registered client (RFC 7591 DCR or CIMD). `0057`
-- adds the column and leaves it `false` on every row; `metadata` survives that
-- file, so filling the column from it is ordinary data repair and lives here
-- rather than in the migration (`docs/NO_TRANSITIONAL_CODE.md` §2).
--
-- What is at stake until it runs: `/oauth2/token` reads `self_service = true`
-- to confine a self-registered client's tokens to a single protected resource
-- (`apps/api/src/modules/oidc/auth/guards.ts`). A row left `false` reads as
-- operator-provisioned, and its tokens are not confined.
--
-- The API refuses to boot while any row this script would fold is left, and its
-- refusal names this file (`assertSelfServiceFoldApplied`,
-- `apps/api/src/lib/boot.ts`). That check reads the same `WHERE` as the UPDATE
-- below, so running this script is always enough to clear it — the unparseable
-- rows it skips are excluded there too.
--
-- WHY `pg_input_is_valid`. `metadata` is `text` and the provider persists what
-- an RFC 7591 registration body presented, so the column is client-influenced:
-- a bare `metadata::jsonb` aborts the whole statement on the first row whose
-- text is not valid JSON. `pg_input_is_valid(metadata, 'jsonb')` tests the cast
-- per row and skips what will not parse, so no single row can fail the fold.
-- It needs **PostgreSQL 16 or later** — the platform's floor (`AGENTS.md`
-- "PostgreSQL 16"; both compose files pin `postgres:16.8-alpine`,
-- `docker-compose.yml` and `docker-compose.dev.yml`) — and the tier-0 embedded
-- backend clears it too (`@electric-sql/pglite` ^0.5.4).
--
-- A row skipped that way keeps `self_service = false`. The last verify query
-- counts them so the operator can look at them by hand; nothing here rewrites
-- unparseable metadata.
--
-- Idempotent: the `WHERE` is exactly the condition it removes — a row still
-- `false` whose metadata says `selfService` — so a second run matches zero
-- rows, and the fold can never flip a `true` back. One transaction, fenced.
--
-- Rows: UNMEASURED. The script prints the count it will fold before and after;
-- the "after" count must be 0.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ═══ VERIFY (before) — the rows the fold WILL touch, and the total it moves ═══
SELECT
  (SELECT count(*) FROM oauth_clients
     WHERE self_service = false
       AND metadata IS NOT NULL
       AND pg_input_is_valid(metadata, 'jsonb')
       AND metadata::jsonb ->> 'selfService' = 'true')  AS to_fold_before,
  (SELECT count(*) FROM oauth_clients
     WHERE self_service = true)                          AS self_service_before;

UPDATE oauth_clients
SET self_service = true
WHERE self_service = false
  AND metadata IS NOT NULL
  AND pg_input_is_valid(metadata, 'jsonb')
  AND metadata::jsonb ->> 'selfService' = 'true';

-- ═══ VERIFY (after) — `to_fold_after` must be 0, and the total must have grown
-- by exactly `to_fold_before`. Both halves are needed: a `WHERE` that matched
-- nothing prints 0 here too, and only the second number tells the two apart ═══
SELECT
  (SELECT count(*) FROM oauth_clients
     WHERE self_service = false
       AND metadata IS NOT NULL
       AND pg_input_is_valid(metadata, 'jsonb')
       AND metadata::jsonb ->> 'selfService' = 'true')  AS to_fold_after,
  (SELECT count(*) FROM oauth_clients
     WHERE self_service = true)                          AS self_service_after;

-- ═══ VERIFY (after) — rows the fold could not read. Expected 0; a non-zero
-- count is a manual inspection, not a failure of this script ═══
SELECT count(*) AS unparseable_metadata
FROM oauth_clients
WHERE metadata IS NOT NULL
  AND NOT pg_input_is_valid(metadata, 'jsonb');

COMMIT;
