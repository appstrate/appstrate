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
 * grants org-level strings ({@link orgPermissions}); a space role grants
 * space-level ones ({@link spacePermissions}), and which space role a caller
 * holds is answered per request by the resolver in `lib/space-role.ts` from a
 * `space_members` row. {@link effectivePermissions} unions the two halves and
 * applies the credential ceiling, so `c.get("permissions")` and every guard
 * keep the exact shape they had.
 *
 * A route outside a space context therefore sees org-level strings only — a
 * space-level guard can never pass on an org route, which is the property the
 * split exists for.
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

/** Member: read the org, its infrastructure and its role catalog; run completions. */
const MEMBER_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>([
  "org:read",
  "members:read",
  "spaces:read",
  // A space `admin` who is only an org member assigns roles in their space, so
  // they must be able to LIST what is assignable. Defining a bundle stays
  // owner/admin (`roles:write` / `roles:delete`) — see RBAC spec §13.6.
  "roles:read",
  "models:read",
  "proxies:read",
  // Members run completions through the platform with the org's configured
  // models (powers first-party chat / remote CLI for ordinary members, not
  // just admins). Usage metered per call in `llm_usage`.
  "llm-proxy:call",
]);

/**
 * Guest: an org identity with no implicit reach into any space (RBAC spec
 * §3.2). Same infrastructure reads as a member minus `members:read` — a guest
 * is an outside collaborator and has no business enumerating the org
 * directory.
 */
const GUEST_ORG_PERMISSIONS: ReadonlySet<OrgLevelPermission> = new Set<OrgLevelPermission>([
  "org:read",
  "spaces:read",
  "models:read",
  "proxies:read",
  // A guest still runs completions in the spaces they were added to; the
  // proxy is org-metered and not space-scoped, so the grant lives here.
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
 * Org-level permissions of `role`: the static grants union the module
 * contributions declared at `level: "org"`.
 *
 * This is the whole set a caller holds outside a space. The space half is
 * resolved per request against a `space_members` row — see
 * `lib/space-role.ts` and {@link effectivePermissions}.
 */
export function orgPermissions(role: OrgRole): Set<Permission> {
  return new Set<Permission>([
    ...ORG_ROLE_PERMISSIONS[role],
    ...(getModuleRoleScopes(role) as ReadonlySet<Permission>),
  ]);
}

/**
 * Space-level permissions of a preset: the static grants union the module
 * contributions that named the preset.
 */
export function presetPermissions(preset: SpaceRolePreset): Set<Permission> {
  return new Set<Permission>([
    ...SPACE_PRESET_PERMISSIONS[preset],
    ...(getModulePresetScopes(preset) as ReadonlySet<Permission>),
  ]);
}

/**
 * Every space-level string the running platform understands: the core catalog
 * plus whatever the loaded modules put in a preset.
 *
 * A module may declare a space-level resource with `presets: []` (legal —
 * API-key-only access); such a string is reachable by no role and therefore by
 * no custom role either, which is fail-closed and the right default. This is
 * the vocabulary a custom `space_roles.permissions` array is filtered against
 * at resolve time, so an unknown string never reaches `Set.has`.
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
 * The vocabulary a custom space role may draw from, grouped for a picker
 * (`GET /api/roles/vocabulary`, RBAC spec §6.2). Same source as
 * {@link knownSpaceLevelPermissions} — that function IS the validator's
 * allowlist, so what the picker offers and what the validator accepts cannot
 * drift.
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
 * Effective permissions for one request: the caller's org-level set union its
 * space-level set (empty on a route with no space context), intersected with
 * the credential's ceiling.
 *
 * `scopeCeiling` is the API-key scope list or the OIDC scope claim; a cookie
 * session has none, so the union stands as-is.
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
 * The org-level effective set an org LISTING exposes per item (RBAC spec
 * §6.5): what the caller's org role grants at org level, plus any per-principal
 * grants a module made them in THAT org, narrowed by the credential's ceiling —
 * an API key's scopes, an OIDC scope claim. Sorted, so the wire order is stable
 * across requests.
 *
 * `principal` comes from `lib/principal-permissions.ts` and is empty for every
 * caller that is not session-shaped. It is a parameter rather than a lookup
 * here because it is per-org and asynchronous, and this function is called once
 * per row of a listing.
 *
 * There is no space half here on purpose: a listing item is an org, and the
 * space slice is answered per space by `GET /api/spaces`.
 */
export function listedOrgPermissions(
  role: OrgRole,
  scopeCeiling?: ReadonlySet<string>,
  principal?: ReadonlySet<string>,
): string[] {
  const org = new Set<string>(orgPermissions(role));
  if (principal) for (const permission of principal) org.add(permission);
  return [...effectivePermissions({ orgPermissions: org, scopeCeiling })].sort();
}

/**
 * Validate API key scopes against the API-key allowlist, then narrow them to
 * the creator's own authority.
 *
 * The two rules are deliberately different in kind:
 *
 *  - A scope that is not API-key-grantable — a typo, a retired spelling, or a
 *    session-only permission such as `org:delete` or `integrations:configure`
 *    — is a REFUSAL (400 naming the offending value). It is not a request the
 *    server can honour in any narrower form, and dropping it mints a key that
 *    silently lacks the access the caller asked for. `POST /api/api-keys
 *    {"scopes":["oops"]}` answering 201 with `scopes: []` is a key that 403s
 *    on everything.
 *  - A scope the creator does not itself hold is FILTERED. "You cannot
 *    delegate more than you have" is a rule, not a mistake, and the
 *    scopes-omitted default (`validateScopes([...getApiKeyAllowedScopes()])`)
 *    depends on it: it hands in the full allowlist precisely so the creator's
 *    own set narrows it.
 *
 * `creatorEffective` is the creator's effective set **in the key's space** —
 * the request that mints a key is space-scoped, so it is exactly the
 * `permissions` the pipeline already computed for that request (RBAC spec
 * §7.1). A `builder` therefore cannot mint `api-keys:create`, because a
 * builder does not hold it.
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
