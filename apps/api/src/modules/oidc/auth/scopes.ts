// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical scope vocabulary for the OIDC module.
 *
 * Kept dependency-free so the hot-path `scopesToPermissions` in `claims.ts`
 * doesn't pull Better Auth / oauth-provider / jose through a transitive
 * import when a core Bearer JWT request only needs to filter scopes.
 */

import { canonicalPermission, getModuleEndUserAllowedScopes } from "@appstrate/core/permissions";
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
  // Documents — the deliverables a run produced. Requestable for the same
  // reason `runs:read` is: an embedding app that may read a run must be able
  // to read what that run published, and `run_and_wait`'s document enrichment
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

/**
 * Rewrite a set of REQUESTED scopes onto the canonical spelling, dropping the
 * duplicate the rewrite creates when a caller sends both spellings.
 *
 * The read-side alias (`canonicalPermission` in `claims.ts`) is not enough on
 * its own: Better Auth's oauth-provider validates the requested scopes against
 * `client.scopes ?? opts.scopes` and HARD-FAILS anything outside that set —
 * `/oauth2/authorize` redirects with `error=invalid_scope`, `/oauth2/token`
 * and `/oauth2/register` throw a 400. Both sides of that comparison are
 * canonical (this module's vocabulary, and `oauth_clients.scopes` after
 * migration 0043), so a client that still sends a retired spelling is refused
 * outright before any claim is built.
 *
 * A scope string is not only persisted, it is also SENT — hardcoded in the
 * config of every satellite, embedded app and MCP client that integrated
 * before the rename, none of which redeploys when the platform does. So the
 * alias has to be applied to the request too, and this is the one helper that
 * does it. Unknown scopes are passed through UNCHANGED so the plugin's own
 * filter still rejects them: this canonicalizes, it never widens.
 */
export function canonicalizeScopes(scopes: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const canonical = canonicalPermission(scope);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * {@link canonicalizeScopes} over a space-delimited OAuth `scope` parameter.
 *
 * Returns `null` when nothing needed rewriting — the overwhelmingly common
 * case — so the caller can leave the request context untouched rather than
 * rebuilding it on every authorize.
 */
export function canonicalizeScopeParam(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const requested = raw.split(" ").filter((s) => s.length > 0);
  const canonical = canonicalizeScopes(requested);
  if (canonical.length === requested.length && canonical.every((s, i) => s === requested[i])) {
    return null;
  }
  return canonical.join(" ");
}
