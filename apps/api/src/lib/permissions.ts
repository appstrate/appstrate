// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC Permission Registry — role-grant matrix + API-key allowlist.
 *
 * The resource catalog itself (`CoreResources`, `CoreResource`,
 * `requireCorePermission`) lives in `@appstrate/core/permissions` so both
 * core routes and externally-published modules can type-check against the
 * same surface without pulling in the API package. This file only holds
 * the runtime role→permissions matrix and the core API-key allowlist —
 * coupled to the auth pipeline, not shippable from npm.
 *
 * ## Core vs module resources
 *
 * Every resource name in `OWNER_PERMISSIONS` / `API_KEY_ALLOWED_SCOPES`
 * below is a **core** resource (i.e. one declared on
 * `CoreResources`). Built-in modules (`webhooks`, `oidc`) and
 * external modules contribute their resources at runtime through
 * `AppstrateModule.permissionsContribution()` (paired with declaration
 * merging on `ModuleResources` for compile-time narrowing).
 * Contributions are aggregated at boot by `collectModulePermissions()`
 * and merged into:
 *   - `resolvePermissions(role)` — role-specific grants
 *   - `getApiKeyAllowedScopes()` — when `apiKeyGrantable: true`
 *   - `getModuleEndUserAllowedScopes()` — when `endUserGrantable: true`
 *
 * Removing a module from `MODULES` leaves zero footprint: no dead scope
 * strings in the role sets, no dead entries in the API-key allowlist.
 *
 * `Resource` is the **union** of both surfaces, so call sites like
 * `requirePermission("webhooks", "read")` type-check uniformly whether
 * `webhooks` ships as a module in this repo or as an external npm
 * package that opened `ModuleResources`.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md
 * @see packages/core/src/permissions.ts (the extension surface)
 */

import {
  type ModuleResources,
  type CoreResource,
  type CoreAction,
  type CorePermission,
  type ModulePermission,
  type OrgRole,
  getModuleRoleScopes,
  getModuleApiKeyScopes,
} from "@appstrate/core/permissions";

// ---------------------------------------------------------------------------
// Resource & Action types — sourced from @appstrate/core/permissions
// ---------------------------------------------------------------------------

/** All resource names — core resources widened with module-augmented entries. */
export type Resource = CoreResource | (keyof ModuleResources & string);

/**
 * Actions available for a given resource. Delegates to `CoreAction<R>` for
 * core resources (keeping the lookup in one place); module-augmented
 * resources resolve against their own declared action union. The `& string`
 * intersection on the module branch is a type-system safety net — if a
 * module ever declares a non-string action type the inferred union
 * collapses to `never`, which propagates as a compile error at the
 * middleware call site.
 */
export type Action<R extends Resource = Resource> = R extends CoreResource
  ? CoreAction<R>
  : R extends keyof ModuleResources
    ? ModuleResources[R] & string
    : never;

/** All valid `resource:action` permission strings, derived from both core + module surfaces. */
export type Permission = CorePermission | ModulePermission;

// ---------------------------------------------------------------------------
// Role → Permission matrix
// ---------------------------------------------------------------------------

/** All permissions for the owner role (all permissions). */
const OWNER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  // Organization
  "org:read",
  "org:update",
  "org:delete",
  "members:read",
  "members:invite",
  "members:remove",
  "members:change-role",
  // Agents
  "agents:read",
  "agents:write",
  "agents:configure",
  "agents:delete",
  "agents:run",
  // Skills
  "skills:read",
  "skills:write",
  "skills:delete",
  // Runs
  "runs:read",
  "runs:cancel",
  "runs:delete",
  // Documents (reads are ungated; delete is owner/admin or the doc's creator)
  "documents:delete",
  // MCP servers (AFPS §3.4 — browse/import/delete, no editor)
  "mcp-servers:read",
  "mcp-servers:write",
  "mcp-servers:delete",
  // Schedules
  "schedules:read",
  "schedules:write",
  "schedules:delete",
  // Persistence (unified checkpoints + memories)
  "persistence:read",
  "persistence:delete",
  // Infrastructure
  "models:read",
  "models:write",
  "models:delete",
  "model-provider-credentials:read",
  "model-provider-credentials:write",
  "model-provider-credentials:delete",
  "proxies:read",
  "proxies:write",
  "proxies:delete",
  // Developer tools
  "api-keys:read",
  "api-keys:create",
  "api-keys:revoke",
  "applications:read",
  "applications:write",
  "applications:delete",
  "end-users:read",
  "end-users:write",
  "end-users:delete",
  // Credential proxy (BYOI — see API_KEY_ALLOWED_SCOPES note below)
  "credential-proxy:call",
  // LLM proxy (remote-backed CLI execution — see API_KEY_ALLOWED_SCOPES note below)
  "llm-proxy:call",
  // Integrations (INTEGRATIONS_PROPOSAL Phase 1.3 — marketplace UI)
  "integrations:read",
  "integrations:write",
  "integrations:delete",
  "integrations:install",
  "integrations:uninstall",
  "integrations:connect",
  "integrations:disconnect",
]);

/** Admin: everything except org:delete and members:change-role. */
const ADMIN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(
  [...OWNER_PERMISSIONS].filter((p) => p !== "org:delete" && p !== "members:change-role"),
);

/** Member: use the platform — run agents, manage own connections, schedules. */
const MEMBER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  // Organization (read only)
  "org:read",
  "members:read",
  // Agents (read + run, no write/configure/delete)
  "agents:read",
  "agents:run",
  // Skills (read only)
  "skills:read",
  // MCP servers (read only — import/delete is admin)
  "mcp-servers:read",
  // Runs (read + cancel own)
  "runs:read",
  "runs:cancel",
  // Schedules (read only — creating/editing schedules, incl. choosing the
  // execution identity, is an admin/owner operation; #738).
  "schedules:read",
  // Persistence (read only — unified checkpoints + memories)
  "persistence:read",
  // Integrations (members can browse + self-connect their connections;
  // install/uninstall is admin)
  "integrations:read",
  "integrations:connect",
  "integrations:disconnect",
  // Infrastructure (read only, except model-provider-credentials which is admin-only)
  "models:read",
  "proxies:read",
  // LLM proxy — members run completions through the platform with the org's
  // configured models (powers first-party chat / remote CLI for ordinary
  // members, not just admins). Usage metered per call in `llm_usage`.
  "llm-proxy:call",
  // Developer tools
  "applications:read",
  "end-users:read",
  "end-users:write",
]);

/** Viewer: read-only on everything visible. */
const VIEWER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "org:read",
  "members:read",
  "agents:read",
  "skills:read",
  "mcp-servers:read",
  "runs:read",
  "schedules:read",
  "persistence:read",
  "models:read",
  "proxies:read",
  "applications:read",
  "end-users:read",
  "integrations:read",
]);

/** Role → core-permissions mapping. Module contributions are layered on top via the provider hook below. */
const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  owner: OWNER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

// ---------------------------------------------------------------------------
// API Key scopes
// ---------------------------------------------------------------------------

/**
 * Core permissions that can be granted to API keys. Session-only
 * operations (org management, personal profiles, etc.) are excluded.
 *
 * Module-contributed API-key scopes (webhooks, oauth-clients, billing, …)
 * are merged in at runtime — callers that need the full set should use
 * {@link getApiKeyAllowedScopes} instead of reading this constant directly.
 */
export const API_KEY_ALLOWED_SCOPES: ReadonlySet<Permission> = new Set<Permission>([
  // Agents
  "agents:read",
  "agents:write",
  "agents:configure",
  "agents:delete",
  "agents:run",
  // Skills
  "skills:read",
  "skills:write",
  "skills:delete",
  // MCP servers (AFPS §3.4 — import/delete via API key for headless flows)
  "mcp-servers:read",
  "mcp-servers:write",
  "mcp-servers:delete",
  // Runs
  "runs:read",
  "runs:cancel",
  "runs:delete",
  // Documents (delete via API key for headless cleanup flows)
  "documents:delete",
  // Schedules
  "schedules:read",
  "schedules:write",
  "schedules:delete",
  // Infrastructure
  "models:read",
  "models:write",
  "models:delete",
  "proxies:read",
  "proxies:write",
  "proxies:delete",
  // Integrations (author/edit the manifest + browse catalog + install/connect
  // via API key for headless flows, incl. end-user OAuth via Appstrate-User
  // header)
  "integrations:read",
  "integrations:write",
  "integrations:delete",
  "integrations:install",
  "integrations:uninstall",
  "integrations:connect",
  "integrations:disconnect",
  // Applications & End-Users
  "applications:read",
  "applications:write",
  "applications:delete",
  "end-users:read",
  "end-users:write",
  "end-users:delete",
  // Credential proxy — BYOI ("Bring Your Own Instance") for remote
  // AFPS runs. High-value scope: one compromised API key can reach every
  // provider in the application. NOT granted by default; callers must
  // explicitly add it when minting the key.
  "credential-proxy:call",
  // LLM proxy — server-side LLM model injection for remote-backed
  // `appstrate run` and headless CI (GitHub Action). Scopes metered
  // per-call in `llm_usage` (source='proxy'). NOT granted by default;
  // callers must explicitly add it when minting the key.
  "llm-proxy:call",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merged view of API-key-grantable permissions (core + modules opted in). */
export function getApiKeyAllowedScopes(): ReadonlySet<string> {
  const moduleAllowed = getModuleApiKeyScopes();
  if (moduleAllowed.size === 0) return API_KEY_ALLOWED_SCOPES;
  return new Set<string>([...API_KEY_ALLOWED_SCOPES, ...moduleAllowed]);
}

/**
 * Resolve an org role to its full permission set — core grants merged
 * with any module-contributed grants for that role.
 */
export function resolvePermissions(role: OrgRole): Set<Permission> {
  const core = ROLE_PERMISSIONS[role];
  const mod = getModuleRoleScopes(role);
  if (mod.size === 0) return new Set(core);
  return new Set<Permission>([...core, ...(mod as ReadonlySet<Permission>)]);
}

/**
 * Role permissions, widened to `ReadonlySet<string>` for ergonomic membership
 * checks against un-narrowed input (API-key scopes, OIDC scope claims, etc.).
 * Use this instead of `resolvePermissions(role)` when the input is a raw
 * string the compiler hasn't narrowed yet — it spares call sites the
 * `has(scope as Permission)` cast without widening the type contract
 * downstream.
 */
export function roleScopes(role: OrgRole): ReadonlySet<string> {
  return resolvePermissions(role);
}

/**
 * Validate and filter API key scopes.
 *
 * Returns only the scopes that are:
 * 1. Valid permission strings (core or module-contributed)
 * 2. Allowed for API keys (not session-only)
 * 3. Within the creator's own permissions (based on their role)
 *
 * The type predicate re-narrows the filtered strings to `Permission` — the
 * runtime invariant is that survival in the filter proves membership in
 * both `allowed` and the creator's role set, both of which are (logically)
 * subsets of the `Permission` union.
 */
export function validateScopes(scopes: string[], creatorRole: OrgRole): Permission[] {
  const creatorPerms = roleScopes(creatorRole);
  const allowed = getApiKeyAllowedScopes();
  return scopes.filter((s): s is Permission => allowed.has(s) && creatorPerms.has(s));
}

/**
 * Compute effective permissions for an API key.
 * Returns the intersection of key scopes with the creator's current role permissions
 * (including module-contributed grants).
 */
export function resolveApiKeyPermissions(scopes: string[], creatorRole: OrgRole): Set<Permission> {
  const rolePerms = roleScopes(creatorRole);
  const effective = new Set<Permission>();
  for (const scope of scopes) {
    if (rolePerms.has(scope)) {
      effective.add(scope as Permission);
    }
  }
  return effective;
}
