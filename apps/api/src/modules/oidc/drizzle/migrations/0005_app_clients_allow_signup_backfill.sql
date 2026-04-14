-- Backfill `allow_signup = true` on pre-existing application-level OAuth
-- clients to preserve the pre-unify effective behavior.
--
-- Context: migration 0001 introduced `allow_signup` with a secure-by-default
-- `false`. The route layer short-circuited `level = 'application'` to
-- effectively-open, so app clients created under that regime behaved as if
-- `allow_signup = true` regardless of the stored value. The follow-up
-- refactor (commit a2aae3af) unified the semantic across all levels and
-- this migration drops the route short-circuit. Without this backfill,
-- existing app clients would flip to closed signup on deploy.
--
-- Idempotent: only touches rows that are still at the default `false`.
-- Safe to re-run; no-op for clients explicitly created with `true` or any
-- app client created after this migration (new defaults are explicit).
--
-- Trade-off accepted: this flips app clients that were *intentionally*
-- created with `allow_signup: false` under the short-circuit regime. Since
-- the short-circuit ignored the flag on app clients, there is no reliable
-- way to distinguish "intentional false" from "default false" — the
-- conservative choice is to preserve the effective behavior (open) rather
-- than surprise integrators with newly-closed signup on deploy. Admins
-- who want closed signup after the migration set it explicitly via PATCH.

UPDATE "oauth_clients"
SET "allow_signup" = true, "updated_at" = now()
WHERE "level" = 'application'
  AND "allow_signup" = false;
