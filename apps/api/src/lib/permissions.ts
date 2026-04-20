// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC Permission Registry — role-grant matrix + API-key allowlist.
 *
 * The resource catalog itself (`AppstrateCoreResources`, `CoreResource`,
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
 * `AppstrateCoreResources`). Built-in modules (`webhooks`, `oidc`) and
 * external modules contribute their resources at runtime through
 * `AppstrateModule.permissionsContribution()` (paired with declaration
 * merging on `AppstrateModuleResources` for compile-time narrowing).
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
 * package that opened `AppstrateModuleResources`.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md
 * @see packages/core/src/permissions.ts (the extension surface)
 */

import {
  CORE_RESOURCE_NAMES,
  type AppstrateCoreResources,
  type AppstrateModuleResources,
  type CoreResource,
  type CorePermission,
  type ModulePermission,
} from "@appstrate/core/permissions";
import type { OrgRole } from "../types/index.ts";

// Re-export so existing apps/api imports of `CORE_RESOURCE_NAMES` from this
// file keep working — the symbol is just now backed by core. The core
// re-export exists to keep the boot-time collision check (in module-loader)
// reading from a single shared source of truth.
export { CORE_RESOURCE_NAMES };

// ---------------------------------------------------------------------------
// Resource & Action types — sourced from @appstrate/core/permissions
// ---------------------------------------------------------------------------

/** All resource names — core resources widened with module-augmented entries. */
export type Resource = CoreResource | (keyof AppstrateModuleResources & string);

/** Actions available for a given resource. */
export type Action<R extends Resource = Resource> = R extends CoreResource
  ? AppstrateCoreResources[R]
  : R extends keyof AppstrateModuleResources
    ? AppstrateModuleResources[R] & string
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
  // Billing
  "billing:read",
  "billing:manage",
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
  // Billing (read only)
  "billing:read",
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
  "billing:read",
]);

/** Role → core-permissions mapping. Module contributions are layered on top via the provider hook below. */
const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  owner: OWNER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

// ---------------------------------------------------------------------------
// Module contribution provider — inversion of dependency
//
// The platform's module-loader registers a provider here at boot. Keeping
// the dependency one-way (loader → permissions) avoids the cyclic import
// `permissions → module-loader → permissions` and keeps this file usable
// in isolation (e.g. unit tests that don't load any module).
// ---------------------------------------------------------------------------

/**
 * Snapshot of all module-contributed permissions, ready for fast Set
 * lookups. Returned by the provider registered through
 * `setModulePermissionsProvider()`. The empty default keeps the file
 * standalone — when no provider is registered (no module loaded, OSS
 * baseline, unit tests) every helper below behaves as if only core
 * permissions exist.
 */
export interface ModulePermissionsSnapshot {
  byRole: Readonly<Record<OrgRole, ReadonlySet<string>>>;
  apiKeyAllowed: ReadonlySet<string>;
  /**
   * Permissions safe to carry on an end-user OIDC token. Populated from
   * `ModulePermissionContribution.endUserGrantable === true` entries.
   * Read by `apps/api/src/modules/oidc/auth/claims.ts` to extend the
   * built-in `OIDC_ALLOWED_SCOPES` filter for end-user tokens.
   */
  endUserAllowed: ReadonlySet<string>;
}

const EMPTY_SNAPSHOT: ModulePermissionsSnapshot = {
  byRole: {
    owner: new Set(),
    admin: new Set(),
    member: new Set(),
    viewer: new Set(),
  },
  apiKeyAllowed: new Set(),
  endUserAllowed: new Set(),
};

let _moduleProvider: () => ModulePermissionsSnapshot = () => EMPTY_SNAPSHOT;

/**
 * Register the boot-time provider for module-contributed permissions.
 * Called once by `module-loader` after all modules have initialized;
 * subsequent calls overwrite the previous provider (intentional — tests
 * use this to inject controlled snapshots, then reset).
 */
export function setModulePermissionsProvider(
  provider: (() => ModulePermissionsSnapshot) | null,
): void {
  _moduleProvider = provider ?? (() => EMPTY_SNAPSHOT);
}

function moduleSnapshot(): ModulePermissionsSnapshot {
  return _moduleProvider();
}

// ---------------------------------------------------------------------------
// API Key scopes
// ---------------------------------------------------------------------------

/**
 * Core permissions that can be granted to API keys.
 * Session-only operations (org management, billing, personal profiles, etc.) are excluded.
 *
 * Module-contributed permissions with `apiKeyGrantable: true` are layered
 * on at runtime — call `getApiKeyAllowedScopes()` for the merged view.
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
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merged view of API-key-grantable permissions (core + modules opted in). */
export function getApiKeyAllowedScopes(): ReadonlySet<string> {
  const moduleAllowed = moduleSnapshot().apiKeyAllowed;
  if (moduleAllowed.size === 0) return API_KEY_ALLOWED_SCOPES;
  return new Set<string>([...API_KEY_ALLOWED_SCOPES, ...moduleAllowed]);
}

/**
 * Module-contributed permissions safe to carry on an end-user OIDC token.
 * Used by `apps/api/src/modules/oidc/auth/claims.ts` to extend the
 * built-in `OIDC_ALLOWED_SCOPES` filter for `actor_type === "end_user"`
 * tokens. Empty when no loaded module opts in via `endUserGrantable: true`.
 *
 * Returns a fresh ReadonlySet view every call (cheap — module snapshot is
 * built once at boot, this just returns the underlying Set reference).
 */
export function getModuleEndUserAllowedScopes(): ReadonlySet<string> {
  return moduleSnapshot().endUserAllowed;
}

/**
 * Resolve an org role to its full permission set — core grants merged
 * with any module-contributed grants for that role.
 */
export function resolvePermissions(role: OrgRole): Set<Permission> {
  const core = ROLE_PERMISSIONS[role];
  const mod = moduleSnapshot().byRole[role];
  if (mod.size === 0) return new Set(core);
  return new Set<Permission>([...core, ...(mod as ReadonlySet<Permission>)]);
}

/** Check if a permission set contains the required `resource:action`. */
export function hasPermission<R extends Resource>(
  permissions: ReadonlySet<string>,
  resource: R,
  action: Action<R>,
): boolean {
  return permissions.has(`${resource}:${action}`);
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
 * The returned array is typed `Permission[]` because survival implies
 * membership in the creator's role set, which is itself a subset of the
 * Permission union. The single `as Permission[]` cast at the return is
 * the boundary where we re-narrow — `filter` with a type predicate over
 * a string union gets rejected by some TS configs, but the runtime
 * invariant is identical.
 */
export function validateScopes(scopes: string[], creatorRole: OrgRole): Permission[] {
  const creatorPerms = roleScopes(creatorRole);
  const allowed = getApiKeyAllowedScopes();
  return scopes.filter((s) => allowed.has(s) && creatorPerms.has(s)) as Permission[];
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
