-- 0004 — restore the RFC 8707 oauth `resources` columns (migration 0006) on a
-- database whose `__drizzle_migrations` watermark skipped them.
--
-- NOT APPLIED ANYWHERE YET, AND NOT REHEARSED. Unlike 0001 and 0002 this one
-- could not be: it repairs a corruption that exists on some deployments and on
-- none reachable from here, so there is no dump to restore and replay against.
-- Every count below is therefore UNMEASURED — the operator measures their own
-- with the "verify before" query, on their own database, before running
-- anything. Do not treat the numbers in the verify block as observations; they
-- are the values the queries MUST return, not values anyone has seen.
--
-- Why this is here and not in packages/db/drizzle/: 0006 already IS the schema
-- and is permanent. This file does not describe the schema — it repairs one
-- database whose migration ledger lies about it, once. See
-- docs/NO_TRANSITIONAL_CODE.md §2.
--
-- What it replaces: `reconcileOAuthResourceColumns()` in apps/api/src/lib/boot.ts
-- ran exactly this DDL on every boot of every deployment, forever, so that a
-- drifted database silently worked. §3 (scaffolding with no expiry) and §5 (a
-- broken form made to work instead of failing loudly). Boot now DETECTS the
-- same condition and REFUSES to start, naming this file —
-- `assertOAuthResourceColumnsPresent()`.
--
-- The bug it fixes: drizzle-orm's postgres-js migrator applies migrations by
-- timestamp watermark (`max(created_at)` in `__drizzle_migrations`), not by
-- hash-set membership. A watermark corrupted to a future date makes the
-- migrator report nothing pending while every migration below that date was
-- never applied. 0006 is one of them, and the pinned better-auth 1.7
-- oauth-provider then queries `resources` columns that do not exist — token
-- mint fails on resource/MCP flows. Tier 0 (PGlite) cannot reach this state:
-- `applyCorePGliteMigrations` keys on the journal tag, not on a watermark.
--
-- ═══ SCOPE — READ THIS BEFORE RUNNING ═══
--
-- This restores 0006 and NOTHING ELSE. The same drift skipped every migration
-- whose journal `when` sits below the corrupted watermark, and this file cannot
-- know which those are. Ledger surgery is deliberately not attempted: lowering
-- the watermark makes the migrator replay migrations that DID apply, and most
-- of them are not idempotent. Run the diagnostic at the bottom first and decide
-- with that list in hand — restoring the columns clears the boot refusal, it
-- does not clear the drift.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is exactly the condition it removes,
-- and the `SET DEFAULT` sets the value 0006 sets, so a second run changes
-- nothing.
--
-- ═══ VERIFY ═══
--
-- Before — must be 0. A 3 means the columns are already present and the boot
-- refusal you are chasing has a different cause:
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_name IN ('oauth_access_tokens','oauth_consents','oauth_refresh_tokens')
--     AND column_name = 'resources';
--
-- After — 3, and the default restored:
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_name IN ('oauth_access_tokens','oauth_consents','oauth_refresh_tokens')
--     AND column_name = 'resources';                                  -- 3
--   SELECT column_default FROM information_schema.columns
--   WHERE table_name = 'oauth_clients' AND column_name = 'level';     -- 'instance'::text
--
-- How far the drift actually goes — this is the query the narrow scope above
-- exists for. It shows the top of the ledger:
--   SELECT id, hash, to_timestamp(created_at / 1000) AS created_at
--   FROM drizzle."__drizzle_migrations" ORDER BY created_at DESC LIMIT 5;
-- Compare the largest `created_at` against the largest `when` in
-- packages/db/drizzle/meta/_journal.json. Anything above it is the corruption;
-- every journal entry whose `when` falls below it and which this database never
-- received is also missing, and is not repaired by this file.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "resources" text[];
ALTER TABLE "oauth_consents" ADD COLUMN IF NOT EXISTS "resources" text[];
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "resources" text[];
ALTER TABLE "oauth_clients" ALTER COLUMN "level" SET DEFAULT 'instance';

COMMIT;
