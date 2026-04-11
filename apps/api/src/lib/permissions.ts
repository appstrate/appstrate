// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC Permission Registry — Single source of truth.
 *
 * Defines the mapping from org roles to permissions (`resource:action`).
 * Used by the `requirePermission()` middleware for both session and API key auth.
 *
 * ## Module-owned resources live here on purpose
 *
 * `ResourceActions` is a **static TypeScript interface** so call sites like
 * `requirePermission("webhooks", "write")` stay fully typed at compile time.
 * That means modules cannot contribute permissions at runtime — a new module
 * that introduces its own resource (e.g. `webhooks`, `billing`) MUST edit
 * this file in the same PR that adds the module:
 *
 *   1. Add the resource to the `ResourceActions` interface below.
 *   2. Add the resource's permissions to the relevant role sets
 *      (`OWNER_PERMISSIONS`, `ADMIN_PERMISSIONS`, `MEMBER_PERMISSIONS`).
 *   3. Add them to `API_KEY_ALLOWED_SCOPES` if they should be grantable
 *      through API keys.
 *
 * This is a deliberate coupling — RBAC is a core concern and type safety
 * at the call site outweighs the "zero-footprint module" invariant. If a
 * module is disabled via `APPSTRATE_MODULES`, its permission entries become
 * unreachable (nothing mounts the routes that check them) but stay in the
 * type union — harmless.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md
 */

import type { OrgRole } from "../types/index.ts";

// ---------------------------------------------------------------------------
// Resource & Action types
// ---------------------------------------------------------------------------

/** Map of resource → allowed actions. Single source of truth for the permission vocabulary. */
interface ResourceActions {
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

/** All resource names. */
export type Resource = keyof ResourceActions;

/** Actions available for a given resource. */
export type Action<R extends Resource = Resource> = ResourceActions[R];

/** All valid `resource:action` permission strings, derived from ResourceActions. */
export type Permission = {
  [R in Resource]: `${R}:${ResourceActions[R]}`;
}[Resource];

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

/** Role → permissions mapping. */
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
 * Permissions that can be granted to API keys.
 * Session-only operations (org management, billing, personal profiles, etc.) are excluded.
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
 * This list is the single source of truth for the OIDC scope vocabulary.
 * The OIDC module's `APPSTRATE_SCOPES` export composes this set with the
 * OIDC identity scopes (`openid`/`profile`/`email`/`offline_access`) — no
 * translation layer, no second vocabulary. The scope string `agents:run`
 * grants the `agents:run` permission verbatim.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve an org role to its permission set. */
export function resolvePermissions(role: OrgRole): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
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
 * 1. Valid permission strings
 * 2. Allowed for API keys (not session-only)
 * 3. Within the creator's own permissions (based on their role)
 */
export function validateScopes(scopes: string[], creatorRole: OrgRole): Permission[] {
  const creatorPerms = ROLE_PERMISSIONS[creatorRole];
  return scopes.filter(
    (s): s is Permission =>
      API_KEY_ALLOWED_SCOPES.has(s as Permission) && creatorPerms.has(s as Permission),
  );
}

/**
 * Compute effective permissions for an API key.
 * Returns the intersection of key scopes with the creator's current role permissions.
 */
export function resolveApiKeyPermissions(scopes: string[], creatorRole: OrgRole): Set<Permission> {
  const rolePerms = ROLE_PERMISSIONS[creatorRole];
  const effective = new Set<Permission>();
  for (const scope of scopes) {
    if (rolePerms.has(scope as Permission)) {
      effective.add(scope as Permission);
    }
  }
  return effective;
}
