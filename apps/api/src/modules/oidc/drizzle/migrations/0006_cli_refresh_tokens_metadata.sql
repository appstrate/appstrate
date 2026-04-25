-- OIDC module: device-session metadata on `cli_refresh_tokens` (issue #251).
--
-- Phase 1 of the "authorized devices" workstream deferred by ADR-006. The
-- columns added below let the platform answer two questions the schema
-- shipped with #227 cannot:
--
--   1. "Which devices are signed in to my account right now?"
--      → human-readable device label, observed UA, observed IP, last-seen
--        timestamp/IP. Without these, every refresh-token row is
--        indistinguishable.
--
--   2. "When did this session last actually do something?"
--      → `last_used_at` + `last_used_ip` updated on each `refresh_token`
--        rotation. Activity attribution for the session list view.
--
-- Storage convention: metadata lives ONLY on the *head of family* — the
-- row inserted at device-code exchange (`parent_id IS NULL`). Rotation
-- rows (children) stay light: read paths join by `family_id` to surface
-- the head row's metadata. This keeps rotation INSERTs minimal and means
-- a session "rename" or "last_used update" is a single UPDATE on the
-- head, never a per-row replicate.
--
-- IP storage: `text`, not `inet`. Mirrors the `session.ip_address` column
-- the Better Auth schema uses (`packages/db/src/schema/auth.ts:47`) — keeps
-- portability across PGlite (Tier-0 dev) and PostgreSQL identical, and
-- avoids parsing pressure on every write. `unknown` is a legitimate value
-- when `TRUST_PROXY` is disabled and the request arrives via a non-direct
-- transport (`getClientIpFromRequest` returns the literal `"unknown"`).
--
-- All columns nullable: pre-existing rows from #227 carry no metadata, and
-- a future `appstrate-cli` invocation that omits the optional
-- `X-Appstrate-Device-Name` header still has a usable session entry.

ALTER TABLE "cli_refresh_tokens"
  ADD COLUMN IF NOT EXISTS "device_name" text,
  ADD COLUMN IF NOT EXISTS "user_agent" text,
  ADD COLUMN IF NOT EXISTS "created_ip" text,
  ADD COLUMN IF NOT EXISTS "last_used_ip" text,
  ADD COLUMN IF NOT EXISTS "last_used_at" timestamp;
