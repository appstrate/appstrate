// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC Permission Registry — org-role matrix, space-role presets, API-key
 * allowlist.
 *
 * The resource catalog itself (`CoreResources`, `CoreResource`, the level
 * table, `requireCorePermission`) lives in `@appstrate/core/permissions` so
 * both core routes and externally-published modules can type-check against
 * the same surface without pulling in the API package. This file only holds
 * the runtime policy — who gets what — which is coupled to the auth pipeline
 * and not shippable from npm.
 *
 * ## Two levels, one Set
 *
 * Every permission belongs to exactly one level (RBAC spec §3.4). An org role
 * grants org-level strings (`ORG_ROLE_PERMISSIONS`); a space role grants
 * space-level ones (`SPACE_PRESET_PERMISSIONS`). `resolvePermissions` unions
 * the two, so `c.get("permissions")` and every guard keep the exact shape they
 * had. Until Phase 2 gives spaces their own membership rows, the preset an
 * org role holds is fixed by `IMPLICIT_PRESET_BY_ORG_ROLE`.
 *
 * ## Core vs module resources
 *
 * Every resource named below is a **core** resource (i.e. one declared on
 * `CoreResources`). Built-in modules (`webhooks`, `oidc`) and
 * external modules contribute their resources at runtime through
 * `AppstrateModule.permissionsContribution()` (paired with declaration
 * merging on `ModuleResources` for compile-time narrowing).
 * Contributions are aggregated at boot by `collectModulePermissions()`
 * and merged into:
 *   - `resolvePermissions(role)` — org-level entries by role, space-level
 *     entries by preset
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

import { invalidRequest } from "./errors.ts";
import {
  type ModuleResources,
  type CoreResource,
  type CoreAction,
  type CorePermission,
  type ModulePermission,
  type OrgLevelPermission,
  type OrgRole,
  type SpaceLevelPermission,
  type SpaceRolePreset,
  ORG_LEVEL_PERMISSIONS,
  SPACE_LEVEL_PERMISSIONS,
  getModuleRoleScopes,
  getModulePresetScopes,
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
// Org roles → org-level permissions (RBAC spec §3.2)
//
// Only ORG-LEVEL strings live here — the type makes a space-level string a
// compile error. What an org role reaches inside a space comes from the
// space-role preset it maps to (below), which is what lets a later phase
// swap the implicit mapping for an explicit `space_members` row without
// touching this table.
// ---------------------------------------------------------------------------

/**
 * Owner: every org-level permission, derived from the core catalog rather
 * than re-listed — a new org-level resource reaches the owner the moment it
 * is declared, instead of silently reaching nobody.
 */
const OWNER_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = ORG_LEVEL_PERMISSIONS;

/**
 * Admin: everything except deleting the organization and renaming it.
 * `org:update` (name/slug) is owner-only per RBAC spec §3.4 — it is the org's
 * identity, and the route that writes it has always been owner-gated.
 */
const ADMIN_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>(
  [...OWNER_ORG_PERMISSIONS].filter((p) => p !== "org:delete" && p !== "org:update"),
);

/** Member: read the org and its infrastructure; run completions. */
const MEMBER_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>([
  "org:read",
  "members:read",
  "spaces:read",
  "models:read",
  "proxies:read",
  // Members run completions through the platform with the org's configured
  // models (powers first-party chat / remote CLI for ordinary members, not
  // just admins). Usage metered per call in `llm_usage`.
  "llm-proxy:call",
]);

/** Viewer: read-only on the org surface. */
const VIEWER_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>([
  "org:read",
  "members:read",
  "spaces:read",
  "models:read",
  "proxies:read",
]);

/** Org role → org-level permissions. Module org grants are layered on at resolve time. */
const ORG_ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<OrgLevelPermission>> = {
  owner: OWNER_ORG_PERMISSIONS,
  admin: ADMIN_ORG_PERMISSIONS,
  member: MEMBER_ORG_PERMISSIONS,
  viewer: VIEWER_ORG_PERMISSIONS,
};

// ---------------------------------------------------------------------------
// Space-role presets → space-level permissions (RBAC spec §3.3)
//
// Constants, not rows: a new space-level permission joins the right preset in
// the same commit that adds it, with no data migration. The type makes an
// org-level string a compile error, so the two halves cannot leak into each
// other.
// ---------------------------------------------------------------------------

/**
 * `admin`: run the space — every space-level permission, derived from the
 * core catalog for the same reason the owner set is.
 */
const ADMIN_PRESET_PERMISSIONS: ReadonlySet<SpaceLevelPermission> = SPACE_LEVEL_PERMISSIONS;

/** Families a `builder` authors and operates with, but does not govern. */
const BUILDER_EXCLUDED_PREFIXES = ["space-settings:", "space-members:", "api-keys:"] as const;

/** `builder`: author and operate — admin minus the governance surfaces. */
const BUILDER_PRESET_PERMISSIONS: ReadonlySet<SpaceLevelPermission> = new Set<SpaceLevelPermission>(
  [...ADMIN_PRESET_PERMISSIONS].filter(
    (p) => !BUILDER_EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)),
  ),
);

/** `operator`: use what is built — run agents, manage own connections. */
const OPERATOR_PRESET_PERMISSIONS: ReadonlySet<SpaceLevelPermission> =
  new Set<SpaceLevelPermission>([
    "agents:read",
    "agents:run",
    "skills:read",
    "mcp-servers:read",
    "runs:read",
    "runs:cancel",
    // Files (read only — deleting is preset admin, or the creator via the
    // per-file capability check, which needs no grant)
    "files:read",
    // Schedules (read only — creating/editing schedules, incl. choosing the
    // execution identity, is a governance operation; #738).
    "schedules:read",
    "persistence:read",
    // Browse the catalog + self-connect; install/uninstall is preset admin.
    "integrations:read",
    "integrations:connect",
    "integrations:disconnect",
    "end-users:read",
    "end-users:write",
  ]);

/** `viewer`: look — the `:read` actions of `operator`. */
const VIEWER_PRESET_PERMISSIONS: ReadonlySet<SpaceLevelPermission> = new Set<SpaceLevelPermission>(
  [...OPERATOR_PRESET_PERMISSIONS].filter((p) => p.endsWith(":read")),
);

/** Space-role preset → space-level permissions. Module preset grants layered on at resolve time. */
const SPACE_PRESET_PERMISSIONS: Record<SpaceRolePreset, ReadonlySet<SpaceLevelPermission>> = {
  admin: ADMIN_PRESET_PERMISSIONS,
  builder: BUILDER_PRESET_PERMISSIONS,
  operator: OPERATOR_PRESET_PERMISSIONS,
  viewer: VIEWER_PRESET_PERMISSIONS,
};

/**
 * Space preset an org role holds implicitly, until Phase 2 replaces this with
 * `space_members` rows and a per-space resolver. Owner/admin run every space;
 * a member uses what is built; a viewer looks.
 */
const IMPLICIT_PRESET_BY_ORG_ROLE: Record<OrgRole, SpaceRolePreset> = {
  owner: "admin",
  admin: "admin",
  member: "operator",
  viewer: "viewer",
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
  // Files (read the gallery / download deliverables; delete via API key
  // for headless cleanup flows)
  "files:read",
  "files:delete",
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
  // Spaces & End-Users
  "spaces:read",
  "spaces:write",
  "spaces:delete",
  "end-users:read",
  "end-users:write",
  "end-users:delete",
  // Credential proxy — BYOI ("Bring Your Own Instance") for remote
  // AFPS runs. High-value scope: one compromised API key can reach every
  // provider in the space. NOT granted by default; callers must
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
 * Resolve an org role to its full permission set: its org-level grants union
 * the space-level grants of the preset it implicitly holds, with module
 * contributions merged into each half.
 */
export function resolvePermissions(role: OrgRole): Set<Permission> {
  const preset = IMPLICIT_PRESET_BY_ORG_ROLE[role];
  return new Set<Permission>([
    ...ORG_ROLE_PERMISSIONS[role],
    ...(getModuleRoleScopes(role) as ReadonlySet<Permission>),
    ...SPACE_PRESET_PERMISSIONS[preset],
    ...(getModulePresetScopes(preset) as ReadonlySet<Permission>),
  ]);
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
 * Validate API key scopes against the API-key allowlist, then narrow them to
 * the creator's own authority.
 *
 * The two rules are deliberately different in kind:
 *
 *  - A scope that is not API-key-grantable — a typo, a retired spelling, or a
 *    session-only permission such as `org:delete` — is a REFUSAL (400 naming
 *    the offending value). It is not a request the server can honour in any
 *    narrower form, and dropping it mints a key that silently lacks the
 *    access the caller asked for. `POST /api/api-keys {"scopes":["oops"]}`
 *    answering 201 with `scopes: []` is a key that 403s on everything.
 *  - A scope the creator's own role does not hold is FILTERED. "You cannot
 *    delegate more than you have" is a rule, not a mistake, and the
 *    scopes-omitted default (`validateScopes([...getApiKeyAllowedScopes()])`)
 *    depends on it: it hands in the full allowlist precisely so the role
 *    narrows it.
 *
 * The type predicate re-narrows the filtered strings to `Permission` — the
 * runtime invariant is that survival in the filter proves membership in
 * both `allowed` (asserted above) and the creator's role set, both of which
 * are (logically) subsets of the `Permission` union.
 *
 * @throws ApiError 400 `invalid_request` when a scope is not grantable to an
 *   API key.
 */
export function validateScopes(scopes: string[], creatorRole: OrgRole): Permission[] {
  const creatorPerms = roleScopes(creatorRole);
  const allowed = getApiKeyAllowedScopes();
  const ungrantable = scopes.filter((s) => !allowed.has(s));
  if (ungrantable.length > 0) {
    throw invalidRequest(
      `Unknown or non-grantable API key scope(s): ${ungrantable.join(", ")}. ` +
        `See GET /api/api-keys/available-scopes for the scopes this role can grant.`,
      "scopes",
    );
  }
  return scopes.filter((s): s is Permission => creatorPerms.has(s));
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
