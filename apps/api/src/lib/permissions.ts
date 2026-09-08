// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC Permission Registry — org-role matrix, space-role presets, API-key
 * allowlist.
 *
 * The resource catalog (`CoreResources`, `CoreResource`, the level table,
 * `requireCorePermission`) lives in `@appstrate/core/permissions`; this file
 * holds only the runtime policy, coupled to the auth pipeline.
 *
 * Every permission is org-level OR space-level (RBAC spec §3.4): org roles
 * grant the former ({@link orgPermissions}), space roles the latter
 * ({@link spacePermissions}, resolved per request in `lib/space-role.ts`);
 * {@link effectivePermissions} unions them under the credential ceiling, so a
 * space-level guard can never pass on a route without space context.
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
 *   - `orgPermissions(role)` — org-level entries, by role
 *   - `presetPermissions(preset)` — space-level entries, by space-role preset
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
  SPACE_ROLE_PRESETS,
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
// Org roles → org-level permissions (RBAC spec §3.2). Only ORG-LEVEL strings
// live here — the type makes a space-level string a compile error.
// ---------------------------------------------------------------------------

/** Owner: every org-level permission, derived from the catalog so a new one reaches the owner unlisted. */
const OWNER_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = ORG_LEVEL_PERMISSIONS;

/** Admin: everything except `org:delete` and `org:update` — the org's identity is owner-only (RBAC spec §3.4). */
const ADMIN_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>(
  [...OWNER_ORG_PERMISSIONS].filter((p) => p !== "org:delete" && p !== "org:update"),
);

/** Member: read the org, its infrastructure and its role catalog; run completions. */
const MEMBER_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>([
  "org:read",
  "members:read",
  "spaces:read",
  // A space `admin` who is only an org member must LIST assignable roles;
  // defining a bundle stays owner/admin (RBAC spec §13.6).
  "roles:read",
  "models:read",
  "proxies:read",
  // Completions with the org's models (first-party chat, remote CLI); metered per call in `llm_usage`.
  "llm-proxy:call",
]);

/**
 * Guest: an org identity with no implicit reach into any space (RBAC spec
 * §3.2). Member reads minus `members:read` — no enumerating the org directory.
 */
const GUEST_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>([
  "org:read",
  "spaces:read",
  "models:read",
  "proxies:read",
  // The proxy is org-metered, not space-scoped, so a guest's grant lives here.
  "llm-proxy:call",
]);

/** Org role → org-level permissions. Module org grants are layered on at resolve time. */
const ORG_ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<OrgLevelPermission>> = {
  owner: OWNER_ORG_PERMISSIONS,
  admin: ADMIN_ORG_PERMISSIONS,
  member: MEMBER_ORG_PERMISSIONS,
  guest: GUEST_ORG_PERMISSIONS,
};

// ---------------------------------------------------------------------------
// Space-role presets → space-level permissions (RBAC spec §3.3). Constants,
// not rows: a new space-level permission joins its preset in the same commit.
// ---------------------------------------------------------------------------

/** `admin`: every space-level permission, derived from the catalog. */
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
    // Files: read only — deleting is preset admin or the creator (per-file capability check).
    "files:read",
    // Schedules: read only — choosing the execution identity is governance (#738).
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
 * Org-level permissions of `role`: static grants union module contributions at
 * `level: "org"`. The space half is resolved per request (`lib/space-role.ts`).
 */
export function orgPermissions(role: OrgRole): Set<Permission> {
  return new Set<Permission>([
    ...ORG_ROLE_PERMISSIONS[role],
    ...(getModuleRoleScopes(role) as ReadonlySet<Permission>),
  ]);
}

/** Space-level permissions of a preset: static grants union module contributions naming it. */
export function presetPermissions(preset: SpaceRolePreset): Set<Permission> {
  return new Set<Permission>([
    ...SPACE_PRESET_PERMISSIONS[preset],
    ...(getModulePresetScopes(preset) as ReadonlySet<Permission>),
  ]);
}

/**
 * Every space-level string the running platform understands: the allowlist a
 * custom `space_roles.permissions` array is filtered against. A module resource
 * with `presets: []` is reachable by no role, custom ones included (fail-closed).
 */
export function knownSpaceLevelPermissions(): ReadonlySet<string> {
  const known = new Set<string>(SPACE_LEVEL_PERMISSIONS);
  for (const preset of SPACE_ROLE_PRESETS) {
    for (const perm of getModulePresetScopes(preset)) known.add(perm);
  }
  return known;
}

/** One space-level permission, with the delegation facts the roles UI shows. */
export interface SpacePermissionEntry {
  permission: string;
  action: string;
  /** Can be carried by an API key (`getApiKeyAllowedScopes`). */
  api_key_grantable: boolean;
}

/** Space-level permissions grouped under their resource, both sorted. */
export interface SpaceVocabularyGroup {
  resource: string;
  permissions: SpacePermissionEntry[];
}

/**
 * Custom-role vocabulary grouped for a picker (`GET /api/roles/vocabulary`,
 * RBAC spec §6.2). Same source as {@link knownSpaceLevelPermissions}, so what
 * the picker offers and what the validator accepts cannot drift.
 */
export function spaceLevelVocabulary(): SpaceVocabularyGroup[] {
  const apiKeyAllowed = getApiKeyAllowedScopes();
  const byResource = new Map<string, SpacePermissionEntry[]>();
  for (const permission of [...knownSpaceLevelPermissions()].sort()) {
    const colon = permission.indexOf(":");
    const resource = permission.slice(0, colon);
    const entries = byResource.get(resource) ?? [];
    entries.push({
      permission,
      action: permission.slice(colon + 1),
      api_key_grantable: apiKeyAllowed.has(permission),
    });
    byResource.set(resource, entries);
  }
  return [...byResource.entries()]
    .map(([resource, permissions]) => ({ resource, permissions }))
    .sort((a, b) => a.resource.localeCompare(b.resource));
}

/**
 * Effective permissions for one request: org-level set ∪ space-level set
 * (empty outside a space context), intersected with the credential ceiling.
 * `scopeCeiling` is the API-key scope list or the OIDC scope claim; a cookie
 * session has none.
 */
export function effectivePermissions(input: {
  orgPermissions: ReadonlySet<string>;
  spacePermissions?: ReadonlySet<string>;
  scopeCeiling?: ReadonlySet<string>;
}): Set<Permission> {
  const { orgPermissions: org, spacePermissions, scopeCeiling } = input;
  const effective = new Set<Permission>();
  for (const perm of org) {
    if (!scopeCeiling || scopeCeiling.has(perm)) effective.add(perm as Permission);
  }
  if (spacePermissions) {
    for (const perm of spacePermissions) {
      if (!scopeCeiling || scopeCeiling.has(perm)) effective.add(perm as Permission);
    }
  }
  return effective;
}

/**
 * Org-level grants of `role` as an org LISTING shows them, sorted. No space
 * half: the space slice is answered per space by `GET /api/spaces`.
 */
export function listedOrgPermissions(role: OrgRole): string[] {
  return [...orgPermissions(role)].sort();
}

/**
 * Validate API key scopes against the API-key allowlist, then narrow them to
 * the creator's own authority.
 *
 * The two rules are deliberately different in kind:
 *
 *  - A scope that is not API-key-grantable — a typo, a retired spelling, or a
 *    session-only permission such as `org:delete` — is a REFUSAL (400 naming
 *    the value): dropping it would mint a key that silently lacks what was asked.
 *  - A scope the creator does not itself hold is FILTERED. "You cannot
 *    delegate more than you have" is a rule, not a mistake, and the
 *    scopes-omitted default (`validateScopes([...getApiKeyAllowedScopes()])`)
 *    depends on it.
 *
 * `creatorEffective` is the creator's effective set in the key's space — the
 * `permissions` the pipeline computed for the minting request (RBAC spec §7.1).
 *
 * @throws ApiError 400 `invalid_request` when a scope is not grantable to an
 *   API key.
 */
export function validateScopes(
  scopes: string[],
  creatorEffective: ReadonlySet<string>,
): Permission[] {
  const allowed = getApiKeyAllowedScopes();
  const ungrantable = scopes.filter((s) => !allowed.has(s));
  if (ungrantable.length > 0) {
    throw invalidRequest(
      `Unknown or non-grantable API key scope(s): ${ungrantable.join(", ")}. ` +
        `See GET /api/api-keys/available-scopes for the scopes you can grant.`,
      "scopes",
    );
  }
  return scopes.filter((s): s is Permission => creatorEffective.has(s));
}
