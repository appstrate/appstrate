// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical scope vocabulary for the OIDC module.
 *
 * Kept dependency-free so the hot-path `scopesToPermissions` in `claims.ts`
 * doesn't pull Better Auth / oauth-provider / jose through a transitive
 * import when a core Bearer JWT request only needs to filter scopes.
 */

import type { Permission } from "../../../lib/permissions.ts";
import { getModuleOidcScopes } from "../../../lib/modules/module-loader.ts";
import { logger } from "../../../lib/logger.ts";

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
 * Built-in scope vocabulary served by the OIDC module. Identity scopes
 * first, then core `Permission` strings drawn from `OIDC_ALLOWED_SCOPES` —
 * no second vocabulary, no translation layer. The scope `agents:run`
 * grants the `agents:run` permission verbatim.
 *
 * Module-contributed scopes (declared via `AppstrateModule.oidcScopes`)
 * extend this vocabulary at boot — see `getAppstrateScopes()` /
 * `getAppstrateScopeSet()` for the dynamic version that includes them.
 * Read this constant only when the caller specifically wants the
 * built-in core list (rare; tests).
 */
export const APPSTRATE_BUILTIN_SCOPES: readonly string[] = [
  ...OIDC_IDENTITY_SCOPES,
  ...OIDC_ALLOWED_SCOPES,
];

/**
 * Full scope vocabulary served by the OIDC module — built-ins plus every
 * scope contributed by other loaded modules via `AppstrateModule.oidcScopes`.
 *
 * Called at boot by `oauthProvider({ scopes })` (so discovery
 * `scopes_supported` advertises the union), at request time by
 * `GET /api/oauth/scopes`, and on every client (re)registration by
 * `assertValidScopes`. Module-contributed entries are deduplicated
 * against the built-ins so a module that re-declares `agents:read` is
 * harmless. Read fresh each call — module loading is one-shot at boot
 * but tests flush the registry between cases.
 */
export function getAppstrateScopes(): readonly string[] {
  const seen = new Set<string>(APPSTRATE_BUILTIN_SCOPES);
  for (const scope of getModuleOidcScopes()) seen.add(scope);
  return Array.from(seen);
}

/** O(1) membership check on the full vocabulary. Materialized per call (cheap). */
export function getAppstrateScopeSet(): ReadonlySet<string> {
  return new Set(getAppstrateScopes());
}

/**
 * @deprecated Prefer `getAppstrateScopes()` / `getAppstrateScopeSet()` so
 * module-contributed scopes are included. Kept as an alias for the
 * built-in list to ease the transition; remove once external consumers
 * have migrated.
 *
 * Reading this value triggers a one-shot `logger.warn` the first time
 * any property is touched (including iteration). The Proxy rebinds
 * method `this` so `[...APPSTRATE_SCOPES]`, `.length`, and index access
 * all keep working against the underlying array. The platform itself
 * never reads this constant — OIDC's boot path uses `getAppstrateScopes()`
 * directly — so the warning fires only on an external consumer import.
 */
export const APPSTRATE_SCOPES: readonly string[] = (() => {
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    logger.warn(
      "APPSTRATE_SCOPES is deprecated; call getAppstrateScopes() to include module-contributed scopes.",
    );
  };
  return new Proxy(APPSTRATE_BUILTIN_SCOPES as readonly string[], {
    get(t, prop, receiver) {
      warn();
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
    has(t, prop) {
      warn();
      return Reflect.has(t, prop);
    },
  });
})();
