// SPDX-License-Identifier: Apache-2.0

/**
 * Current encryption-key version tag for per-app secret tables
 * (`application_smtp_configs`, `application_social_providers`).
 *
 * Admin writes stamp this value on the row. Resolvers reject rows whose
 * stamped version differs, surfacing them as "not configured" instead of
 * letting `decryptCredentials` throw on stale ciphertext. Rotation SOP:
 *  1. Bump this constant alongside the `CONNECTION_ENCRYPTION_KEY` rollout.
 *  2. Operators re-upsert every per-app row via the admin API — new writes
 *     get the new version tag and are readable again.
 *  3. Rows still carrying the old tag stay unreachable (email/social features
 *     disabled for that app) until explicitly rewritten — no silent fallback
 *     to env creds, matches the PR's per-app isolation invariant.
 */
export const CURRENT_ENCRYPTION_KEY_VERSION = "v1";
