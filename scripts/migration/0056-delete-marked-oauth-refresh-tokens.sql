-- SPDX-License-Identifier: Apache-2.0
-- Run once after deploying the release that ends OAuth tokens by deleting them (#2325), inside or
-- after the deploy window; the app may keep running. Back up the database first.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f this-file.sql
-- For PGlite (single process), execute this batch on the PGLITE_DATA_DIR with the app stopped.
-- Idempotent: re-running deletes nothing.
--
-- WHAT. Deletes the refresh tokens an administrative revocation marked: `revoked IS NOT NULL AND
-- rotated_at IS NULL`. Better Auth's own rotation sets `rotated_at` together with `revoked` (the
-- `rotationUpdate` object of `@better-auth/oauth-provider`), so a marked row without `rotated_at`
-- was ended by an administrative path: the platform's member exit and password change before this
-- release, script 0019, or Better Auth's `/oauth2/revoke`.
--
-- WHY. Better Auth reads a marked refresh token presented again outside the reuse window as stolen
-- and deletes every refresh token of the (client, user) pair, on every resource and org. The
-- release no longer marks; the rows already marked are still in the database and each one is a
-- trigger a stale client can pull. Such a row grants nothing (a revoked token is refused), so
-- deleting it changes no access and removes the trigger. A deleted token presented again is a plain
-- `invalid_grant`.
--
-- WHAT STAYS. Rotated-out rows (`rotated_at IS NOT NULL`) are Better Auth's real reuse detection.
-- `rotated_at` exists since drizzle 0057 (provider 1.7.3): a row rotated before it has `revoked`
-- and no `rotated_at`, so it is deleted here too. It is already dead; the only loss is replay
-- detection on it, until it expires.
--
-- CASCADE. `oauth_access_tokens.refresh_id` references `oauth_refresh_tokens(id) ON DELETE CASCADE`
-- (drizzle 0003): the access-token rows of a deleted refresh token go with it. Nothing else is
-- touched; a marked access token triggers nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- Preview (read-only): what the DELETE below removes, and what it keeps.
SELECT
  count(*) FILTER (WHERE revoked IS NOT NULL AND rotated_at IS NULL) AS marked_to_delete,
  count(*) FILTER (WHERE revoked IS NOT NULL AND rotated_at IS NOT NULL) AS rotated_kept,
  count(*) FILTER (WHERE revoked IS NULL) AS live_kept
FROM oauth_refresh_tokens;

WITH removed AS (
  DELETE FROM oauth_refresh_tokens
  WHERE revoked IS NOT NULL AND rotated_at IS NULL
  RETURNING 1
)
SELECT count(*) AS refresh_tokens_deleted FROM removed;

-- Must be 0.
SELECT count(*) AS marked_refresh_tokens_left
FROM oauth_refresh_tokens
WHERE revoked IS NOT NULL AND rotated_at IS NULL;
COMMIT;
