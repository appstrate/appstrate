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
import { logger } from "./logger.ts";

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
  // Tools
  "tools:read",
  "tools:write",
  "tools:delete",
  // Providers
  "providers:read",
  "providers:write",
  "providers:delete",
  // Runs
  "runs:read",
  "runs:cancel",
  "runs:delete",
  // Schedules
  "schedules:read",
  "schedules:write",
  "schedules:delete",
  // Memories
  "memories:read",
  "memories:delete",
  // Connections
  "connections:read",
  "connections:connect",
  "connections:disconnect",
  // Profiles
  "profiles:read",
  "profiles:write",
  "profiles:delete",
  // Org profiles
  "app-profiles:read",
  "app-profiles:write",
  "app-profiles:delete",
  "app-profiles:bind",
  // Infrastructure
  "models:read",
  "models:write",
  "models:delete",
  "provider-keys:read",
  "provider-keys:write",
  "provider-keys:delete",
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
  // Skills, Tools, Providers (read only)
  "skills:read",
  "tools:read",
  "providers:read",
  // Runs (read + cancel own)
  "runs:read",
  "runs:cancel",
  // Schedules (read + write + delete own)
  "schedules:read",
  "schedules:write",
  "schedules:delete",
  // Memories (read only)
  "memories:read",
  // Connections (full self-service)
  "connections:read",
  "connections:connect",
  "connections:disconnect",
  // Profiles (personal)
  "profiles:read",
  "profiles:write",
  "profiles:delete",
  // Org profiles (read + bind own connections)
  "app-profiles:read",
  "app-profiles:bind",
  // Infrastructure (read only, except provider-keys which is admin-only)
  "models:read",
  "proxies:read",
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
  "tools:read",
  "providers:read",
  "runs:read",
  "schedules:read",
  "memories:read",
  "connections:read",
  "profiles:read",
  "app-profiles:read",
  "models:read",
  "proxies:read",
  "applications:read",
  "end-users:read",
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
 * Internal source of truth. Inside apps/api, always read this value —
 * the public re-export `API_KEY_ALLOWED_SCOPES` wraps it in a logging
 * proxy that emits a one-shot deprecation warning on first access, so
 * reading the private const avoids a spurious warning during every boot
 * of the platform itself.
 */
const API_KEY_ALLOWED_SCOPES_CORE: ReadonlySet<Permission> = new Set<Permission>([
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
  // Tools
  "tools:read",
  "tools:write",
  "tools:delete",
  // Providers
  "providers:read",
  "providers:write",
  "providers:delete",
  // Runs
  "runs:read",
  "runs:cancel",
  "runs:delete",
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
  // Connections (end-user OAuth via API key + Appstrate-User header)
  "connections:read",
  "connections:connect",
  "connections:disconnect",
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

/**
 * Public (deprecated) export of the core API-key allowlist.
 *
 * @deprecated Use `getApiKeyAllowedScopes()` instead — it returns the
 * merged view (core + module contributions opted in via
 * `apiKeyGrantable: true`). Reading this constant returns only the core
 * half and will silently diverge from reality whenever a module
 * contributes API-key-grantable scopes.
 *
 * Kept as a backwards-compat alias; the Proxy wrapper below emits a
 * one-shot `logger.warn` the first time any external reader touches it,
 * so operators see an actionable migration signal without log spam.
 * Internal callers read `API_KEY_ALLOWED_SCOPES_CORE` directly.
 */
export const API_KEY_ALLOWED_SCOPES: ReadonlySet<Permission> = wrapDeprecatedSet(
  API_KEY_ALLOWED_SCOPES_CORE,
  "API_KEY_ALLOWED_SCOPES",
  "getApiKeyAllowedScopes()",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merged view of API-key-grantable permissions (core + modules opted in). */
export function getApiKeyAllowedScopes(): ReadonlySet<string> {
  const moduleAllowed = getModuleApiKeyScopes();
  if (moduleAllowed.size === 0) return API_KEY_ALLOWED_SCOPES_CORE;
  return new Set<string>([...API_KEY_ALLOWED_SCOPES_CORE, ...moduleAllowed]);
}

/**
 * Wrap a ReadonlySet in a Proxy that logs a one-shot deprecation warning
 * the first time any property is accessed (`.has`, `.size`, iteration,
 * etc.). Method lookups are rebound to the original target so `has(x)`
 * continues to work through the Proxy; the warning fires exactly once
 * per process.
 */
function wrapDeprecatedSet<T>(
  target: ReadonlySet<T>,
  name: string,
  replacement: string,
): ReadonlySet<T> {
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    logger.warn(`${name} is deprecated; read ${replacement} to include module-contributed scopes.`);
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      warn();
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
    has(t, prop) {
      warn();
      return Reflect.has(t, prop);
    },
  }) as ReadonlySet<T>;
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
