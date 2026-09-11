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
 * End-users are NOT org members — they impersonate through a space
 * via a JWT minted by the OIDC module's oauth-provider. This allowlist is
 * the intersection of (a) safe-for-end-user permissions and (b) permissions
 * whose routes are compatible with the strict end-user run-filter.
 *
 * Destructive and admin-scoped permissions (`agents:write`, `agents:delete`,
 * `runs:delete`, `api-keys:*`, `webhooks:*`, `spaces:*`, `end-users:*`,
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
  // Files — the deliverables a run produced. Requestable for the same
  // reason `runs:read` is: an embedding app that may read a run must be able
  // to read what that run published, and `run_and_wait`'s file enrichment
  // (`fetchRunFiles`) is best-effort, so without this scope the list
  // silently comes back EMPTY rather than erroring. Read-only and still
  // narrowed per row by the container ACL (an end-user only ever resolves its
  // own runs' files), so it carries no more reach than `runs:read`.
  // Deleting stays out: `files:delete` is admin/creator work.
  "files:read",
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
 * Permissions an OAuth client may REQUEST but that no end-user token can
 * carry — the requestable vocabulary is wider than the end-user allowlist.
 *
 * `runs:read-all` is the space-wide supervision read (`lib/run-visibility.ts`).
 * It must stay out of {@link OIDC_ALLOWED_SCOPES}: an embedding app acting for
 * an end-user must never see a colleague's or another end-user's run. But an
 * org-level client acting for a dashboard user IS the supervision surface —
 * `scopesToPermissions("dashboard_user", role)` intersects the request with the
 * subject's live authority, so an admin gets it and a `runner` does not. Absent
 * from the vocabulary entirely, the scope could not be asked for at all and
 * every dashboard token was silently capped at its own runs (issue #1372).
 *
 * Self-service (DCR / CIMD) registrants are unaffected: their ceiling is
 * {@link getSelfServiceScopes}, which lists no core action scope.
 */
export const OIDC_DASHBOARD_ONLY_SCOPES: ReadonlySet<Permission> = new Set<Permission>([
  "runs:read-all",
]);

/**
 * Static core scope vocabulary: identity scopes first, then the core
 * `Permission` strings a client may request — the end-user allowlist plus the
 * dashboard-only scopes. No translation layer: the scope `agents:run` grants
 * the `agents:run` permission verbatim.
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
  ...OIDC_DASHBOARD_ONLY_SCOPES,
];

/**
 * Scope ceiling for self-service (DCR / CIMD) clients: identity scopes plus
 * every module end-user-grantable scope. Evaluated per call, fresh array.
 */
export function getSelfServiceScopes(): string[] {
  return [...OIDC_IDENTITY_SCOPES, ...getModuleEndUserAllowedScopes()];
}

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

/**
 * The subset of the vocabulary an END-USER token can actually carry — exactly
 * what `scopesToPermissions(…, "end_user")` keeps.
 *
 * The registration gate for space-level clients: everything a space client
 * requests is minted onto `end_user` tokens, so a dashboard-only scope
 * registered there would be dropped at every mint and the operator would never
 * hear about it. Refusing it at registration keeps the silent narrowing this
 * module fixed for dashboard tokens from reappearing for space clients.
 */
export function getEndUserScopeSet(): ReadonlySet<string> {
  const dashboardOnly = OIDC_DASHBOARD_ONLY_SCOPES as ReadonlySet<string>;
  return new Set(getAppstrateScopes().filter((scope) => !dashboardOnly.has(scope)));
}
