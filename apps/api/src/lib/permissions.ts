// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC Permission Registry — Single source of truth for core resources.
 *
 * Defines the mapping from org roles to permissions (`resource:action`).
 * Used by the `requirePermission()` middleware for both session and API key auth.
 *
 * ## Core resources vs module-contributed resources
 *
 * `CoreResourceActions` is a **static TypeScript interface** so call sites like
 * `requirePermission("webhooks", "write")` stay fully typed at compile time.
 * In-house modules that ship inside the platform (`webhooks`, `oidc`,
 * `billing`) are listed here directly — they are not opt-out, so the
 * compile-time guarantee outweighs the "zero-footprint" invariant for them.
 *
 * Truly external modules (anyone publishing on npm against
 * `@appstrate/core`) extend the resource catalog through TypeScript
 * declaration merging on `AppstrateModuleResources` (see
 * `@appstrate/core/permissions`) plus a runtime contribution through
 * `AppstrateModule.permissionsContribution()`. Both are aggregated at
 * boot — see `getModulePermissions()` in `lib/modules/module-loader.ts`.
 *
 * The `Resource` type is the **union** of both surfaces, so call sites
 * like `requirePermission("chat", "read")` work uniformly regardless of
 * whether `chat` came from core or from `@third-party/chat`.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md
 * @see packages/core/src/permissions.ts (the extension surface)
 */

import type { AppstrateModuleResources } from "@appstrate/core/permissions";
import type { OrgRole } from "../types/index.ts";

// ---------------------------------------------------------------------------
// Resource & Action types
// ---------------------------------------------------------------------------

/** Core resources owned by the platform (and its in-house modules). */
interface CoreResourceActions {
  org: "read" | "update" | "delete";
  members: "read" | "invite" | "remove" | "change-role";
  agents: "read" | "write" | "configure" | "delete" | "run";
  skills: "read" | "write" | "delete";
  tools: "read" | "write" | "delete";
  providers: "read" | "write" | "delete";
  runs: "read" | "cancel" | "delete";
  schedules: "read" | "write" | "delete";
  memories: "read" | "delete";
  connections: "read" | "connect" | "disconnect";
  profiles: "read" | "write" | "delete";
  "app-profiles": "read" | "write" | "delete" | "bind";
  models: "read" | "write" | "delete";
  "provider-keys": "read" | "write" | "delete";
  proxies: "read" | "write" | "delete";
  "api-keys": "read" | "create" | "revoke";
  applications: "read" | "write" | "delete";
  "end-users": "read" | "write" | "delete";
  webhooks: "read" | "write" | "delete";
  "oauth-clients": "read" | "write" | "delete";
  billing: "read" | "manage";
}

/** Core resource names — used by the role-grant matrix below. */
type CoreResource = keyof CoreResourceActions;

/** All resource names — core resources widened with module-augmented entries. */
export type Resource = CoreResource | (keyof AppstrateModuleResources & string);

/** Actions available for a given resource. */
export type Action<R extends Resource = Resource> = R extends CoreResource
  ? CoreResourceActions[R]
  : R extends keyof AppstrateModuleResources
    ? AppstrateModuleResources[R] & string
    : never;

/** All valid `resource:action` permission strings, derived from both core + module surfaces. */
export type Permission =
  | {
      [R in CoreResource]: `${R}:${CoreResourceActions[R]}`;
    }[CoreResource]
  | {
      [R in keyof AppstrateModuleResources &
        string]: `${R}:${AppstrateModuleResources[R] & string}`;
    }[keyof AppstrateModuleResources & string];

/** Names of the core resources (read by the boot validator to detect collisions with module contributions). */
export const CORE_RESOURCE_NAMES: ReadonlySet<string> = new Set<string>([
  "org",
  "members",
  "agents",
  "skills",
  "tools",
  "providers",
  "runs",
  "schedules",
  "memories",
  "connections",
  "profiles",
  "app-profiles",
  "models",
  "provider-keys",
  "proxies",
  "api-keys",
  "applications",
  "end-users",
  "webhooks",
  "oauth-clients",
  "billing",
]);

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
  "webhooks:read",
  "webhooks:write",
  "webhooks:delete",
  // OAuth clients (OIDC module)
  "oauth-clients:read",
  "oauth-clients:write",
  "oauth-clients:delete",
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
}

const EMPTY_SNAPSHOT: ModulePermissionsSnapshot = {
  byRole: {
    owner: new Set(),
    admin: new Set(),
    member: new Set(),
    viewer: new Set(),
  },
  apiKeyAllowed: new Set(),
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
  // Webhooks
  "webhooks:read",
  "webhooks:write",
  "webhooks:delete",
  // OAuth clients (OIDC module)
  "oauth-clients:read",
  "oauth-clients:write",
  "oauth-clients:delete",
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
 * Validate and filter API key scopes.
 *
 * Returns only the scopes that are:
 * 1. Valid permission strings (core or module-contributed)
 * 2. Allowed for API keys (not session-only)
 * 3. Within the creator's own permissions (based on their role)
 */
export function validateScopes(scopes: string[], creatorRole: OrgRole): Permission[] {
  const creatorPerms = resolvePermissions(creatorRole);
  const allowed = getApiKeyAllowedScopes();
  return scopes.filter((s): s is Permission => allowed.has(s) && creatorPerms.has(s as Permission));
}

/**
 * Compute effective permissions for an API key.
 * Returns the intersection of key scopes with the creator's current role permissions
 * (including module-contributed grants).
 */
export function resolveApiKeyPermissions(scopes: string[], creatorRole: OrgRole): Set<Permission> {
  const rolePerms = resolvePermissions(creatorRole);
  const effective = new Set<Permission>();
  for (const scope of scopes) {
    if (rolePerms.has(scope as Permission)) {
      effective.add(scope as Permission);
    }
  }
  return effective;
}
