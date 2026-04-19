-- OIDC module: CLI refresh tokens with family-based rotation + reuse detection.
--
-- Replaces the 7-day BA session token returned by `/api/auth/device/token`
-- (issue #165) with a short-lived (15 min) signed JWT access token + a
-- 30-day opaque refresh token that rotates on every use. One row per
-- refresh token ever issued to the CLI (`appstrate-cli` public client).
--
-- Rotation contract:
--   - `used_at IS NULL` → token is usable; `POST /api/auth/cli/token`
--     with `grant_type=refresh_token` accepts it once, marks `used_at`
--     on this row, and inserts a NEW row with `parent_id = this.id` and
--     the SAME `family_id`. The CLI persists the new token and discards
--     the old one.
--   - `used_at IS NOT NULL` → the token has already been exchanged. A
--     second presentation is reuse (RFC 6819 § 5.2.2.3): the guard
--     revokes EVERY row in the same `family_id` (sets `revoked_at` +
--     `revoked_reason='reuse'`) and returns `invalid_grant`. The CLI
--     must re-run `appstrate login`.
--   - `revoked_at IS NOT NULL` → family already revoked (either reuse
--     detection or explicit `POST /api/auth/cli/revoke`). Rejects with
--     `invalid_grant`.
--   - `expires_at < now()` → rejects with `invalid_grant`; the CLI
--     re-auths through device flow.
--
-- Storage: tokens are 32 bytes of CSPRNG entropy, base64url-encoded
-- (43 chars). We store SHA-256(plaintext) as `token_hash` (unique index);
-- the plaintext is returned once to the CLI and never persisted. On
-- lookup we recompute the hash from the presented string and match by
-- column — constant-time when equality is handled by the B-tree lookup,
-- and zero-value-leak on compromise (an attacker with SELECT privilege
-- sees only hashes, not usable tokens).
--
-- `family_id`: stable lineage identifier (same across rotations). The
-- revoke-family query is a single UPDATE WHERE family_id = $1.
--
-- `parent_id`: self-referential FK to the row that rotated into this
-- one. Forms a linked list back to the initial device-code grant. Used
-- for audit + debugging; NOT required for the rotation logic itself
-- (which only needs `family_id` + `used_at`).
--
-- Audit columns: `created_at`, `used_at`, `revoked_at`, `revoked_reason`.
-- Operators can query the full lineage of a revoked family to see which
-- node was compromised and when.

CREATE TABLE IF NOT EXISTS "cli_refresh_tokens" (
  "id" text PRIMARY KEY,
  "token_hash" text NOT NULL UNIQUE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE,
  "family_id" text NOT NULL,
  "parent_id" text REFERENCES "cli_refresh_tokens"("id") ON DELETE SET NULL,
  "scope" text,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "used_at" timestamp,
  "revoked_at" timestamp,
  "revoked_reason" text
);

-- Family revocation is the hot path when reuse is detected — a WHERE on
-- `family_id` must not degrade to a seq-scan as the table grows. Each
-- successful login produces one family; each rotation adds one row; each
-- logout reads the family to revoke. Users rotating every 15 min for
-- 30 days → ~2880 rows per family; a pending-active deployment with
-- 10k users stays well under 100M rows lifetime.
CREATE INDEX IF NOT EXISTS "idx_cli_refresh_tokens_family"
  ON "cli_refresh_tokens" ("family_id");

-- User-scoped listing (admin "authorized devices" UI, future v1.1) +
-- cascade semantics on `user` deletion.
CREATE INDEX IF NOT EXISTS "idx_cli_refresh_tokens_user"
  ON "cli_refresh_tokens" ("user_id");
