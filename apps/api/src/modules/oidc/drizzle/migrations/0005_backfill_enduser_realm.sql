-- Backfill `user.realm` for Better Auth users linked to an OIDC end-user
-- profile. Users created before `packages/db/drizzle/0001_add_user_realm.sql`
-- defaulted to `realm="platform"` — including end-users of application-level
-- OIDC clients, which would then be rejected at token mint by the new
-- `assertUserRealm` check in `auth/plugins.ts`.
--
-- The join key is the module's shadow table `oidc_end_user_profiles`
-- (auth_user_id → end_users.id → end_users.application_id). Only users
-- currently at the default "platform" realm are touched; users already
-- tagged (e.g. freshly created after 0001) are left alone. DISTINCT ON
-- picks a deterministic row when a single BA user has profiles across
-- multiple apps (ordered by end_user creation to match the first-app
-- binding — the common case is one app per BA identity anyway).
--
-- Rerun-safe: the `realm = 'platform'` guard makes the UPDATE idempotent
-- after the first successful run. No-op when the module is added to a
-- pristine DB (no rows yet).
UPDATE "user" AS u
SET realm = 'end_user:' || sub.application_id
FROM (
  SELECT DISTINCT ON (p.auth_user_id)
    p.auth_user_id,
    eu.application_id
  FROM oidc_end_user_profiles p
  INNER JOIN end_users eu ON eu.id = p.end_user_id
  WHERE p.auth_user_id IS NOT NULL
  ORDER BY p.auth_user_id, eu.created_at ASC
) AS sub
WHERE u.id = sub.auth_user_id
  AND u.realm = 'platform';
