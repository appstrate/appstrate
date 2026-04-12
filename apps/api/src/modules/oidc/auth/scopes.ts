// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical scope vocabulary for the OIDC module.
 *
 * Kept dependency-free so the hot-path `scopesToPermissions` in `claims.ts`
 * doesn't pull Better Auth / oauth-provider / jose through a transitive
 * import when a core Bearer JWT request only needs to filter scopes.
 */

import type { Permission } from "../../../lib/permissions.ts";

/**
 * OIDC protocol scopes that grant no Appstrate permission. Required by the
 * oauth-provider plugin (`openid`/`profile`/`email`) and by every standard
 * OIDC client library. `offline_access` gates refresh-token issuance.
 */
export const OIDC_IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/** O(1) membership check on identity scopes — avoids re-materializing a Set per call. */
export const OIDC_IDENTITY_SCOPE_SET: ReadonlySet<string> = new Set(OIDC_IDENTITY_SCOPES);

/**
 * Permissions that can be granted to end-user OIDC JWTs.
 *
 * End-users are NOT org members — they impersonate through an application
 * via a JWT minted by the OIDC module's oauth-provider. This allowlist is
 * the intersection of (a) safe-for-end-user permissions and (b) permissions
 * whose routes are compatible with the strict end-user run-filter.
 *
 * Destructive and admin-scoped permissions (`agents:write`, `agents:delete`,
 * `runs:delete`, `api-keys:*`, `webhooks:*`, `applications:*`, `end-users:*`,
 * `provider-keys:*`, etc.) are excluded — they are admin work, not end-user
 * work, and granting them through a user-consented OAuth flow would let an
 * embedding app silently escalate.
 *
 * Module-owned on purpose: this vocabulary is OIDC-specific and must not
 * leak into core. Core exposes the `Permission` type union as the shared
 * contract; this module composes its own allowlist from it.
 */
export const OIDC_ALLOWED_SCOPES: ReadonlySet<Permission> = new Set<Permission>([
  "agents:read",
  "agents:run",
  "runs:read",
  "runs:cancel",
  "connections:read",
  "connections:connect",
  "connections:disconnect",
  // Read-only catalog access — safe to surface to embedding apps so they can
  // render skill/tool/provider/model metadata alongside their own UI.
  "skills:read",
  "tools:read",
  "providers:read",
  "models:read",
]);

/**
 * Canonical scope vocabulary served by the OIDC module. Identity scopes
 * first, then core `Permission` strings drawn from `OIDC_ALLOWED_SCOPES` —
 * no second vocabulary, no translation layer. The scope `agents:run`
 * grants the `agents:run` permission verbatim.
 *
 * The admin UI, the consent page, and `/.well-known/openid-configuration`
 * all read from this array via `GET /api/oauth/scopes`.
 */
export const APPSTRATE_SCOPES: readonly string[] = [
  ...OIDC_IDENTITY_SCOPES,
  ...OIDC_ALLOWED_SCOPES,
];
