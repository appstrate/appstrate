// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical scope vocabulary for the OIDC module.
 *
 * Kept dependency-free so the hot-path `scopesToPermissions` in `claims.ts`
 * doesn't pull Better Auth / oauth-provider / jose through a transitive
 * import when a core Bearer JWT request only needs to filter scopes.
 */

import { getModuleEndUserAllowedScopes } from "@appstrate/core/permissions";
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
 * `model-provider-credentials:*`, etc.) are excluded — they are admin work, not
 * end-user work, and granting them through a user-consented OAuth flow would
 * let an embedding app silently escalate.
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
  "integrations:read",
  "integrations:connect",
  "integrations:disconnect",
  // Read-only catalog access — safe to surface to embedding apps so they can
  // render skill/model metadata alongside their own UI.
  "skills:read",
  "models:read",
  // LLM proxy — server-side model injection for chat/agent clients that run
  // completions through the platform with the org's configured models. Metered
  // per call in the `llm_usage` ledger. Must be in the requestable vocabulary
  // for clients (e.g. the chat BFF) to acquire it; dashboard tokens remain
  // gated by the caller's org role on top of the requested scope.
  "llm-proxy:call",
]);

/**
 * Static core scope vocabulary: identity scopes first, then the core
 * `Permission` strings drawn from `OIDC_ALLOWED_SCOPES` — no translation
 * layer, the scope `agents:run` grants the `agents:run` permission verbatim.
 *
 * Module-contributed scopes (e.g. `mcp:read`/`mcp:invoke`) are NOT listed
 * here — they are merged dynamically by `getAppstrateScopes()` from each
 * module's `permissionsContribution({ endUserGrantable: true })`, mirroring
 * the end-user filter in `claims.ts`. This keeps the static list typed
 * against the core `Permission` union (which doesn't include module
 * resources at compile time in every consumer) while still advertising
 * module scopes at runtime.
 */
export const APPSTRATE_BUILTIN_SCOPES: readonly string[] = [
  ...OIDC_IDENTITY_SCOPES,
  ...OIDC_ALLOWED_SCOPES,
];

/**
 * Full scope vocabulary served by the OIDC module — core built-ins plus any
 * module scopes opted in via `endUserGrantable: true`.
 *
 * Called at boot by `oauthProvider({ scopes })` (so discovery
 * `scopes_supported` advertises the vocabulary), at request time by
 * `GET /api/oauth/scopes`, and on every client (re)registration by
 * `assertValidScopes`. Kept as a function (not a bare const) so callers see
 * the live set after modules have contributed.
 */
export function getAppstrateScopes(): readonly string[] {
  return [...APPSTRATE_BUILTIN_SCOPES, ...getModuleEndUserAllowedScopes()];
}

/** O(1) membership check on the full vocabulary. Materialized per call (cheap). */
export function getAppstrateScopeSet(): ReadonlySet<string> {
  return new Set(getAppstrateScopes());
}
