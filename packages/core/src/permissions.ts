// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC contract — core resource catalog + module extension point.
 *
 * This file owns two surfaces that together let any code (in core, in the
 * platform, or in an external module) talk about Appstrate permissions
 * with full TypeScript narrowing:
 *
 *   1. `CoreResources` — the **static** catalog of resources the
 *      platform itself ships. Adding a new core resource is an edit here
 *      (interface property) plus an edit in
 *      `apps/api/src/lib/permissions.ts` (role grants + API-key allowlist).
 *      The interface lives in core so that external modules can build
 *      typed middleware against it (see `requireCorePermission` below)
 *      without reaching into `apps/api`.
 *
 *   2. `ModuleResources` — the **extensible** catalog modules
 *      augment via TypeScript declaration merging. Each augmenting module
 *      pairs the type-level `declare module` with a runtime
 *      `AppstrateModule.permissionsContribution()` so the platform's
 *      role-grant matrix and API-key allowlist pick the new resource up
 *      at boot.
 *
 * The platform's `Resource` / `Permission` union (in
 * `apps/api/src/lib/permissions.ts`) is the union of both surfaces — call
 * sites like `requirePermission("agents", "read")` and
 * `requirePermission("tasks", "read")` work uniformly regardless of origin.
 *
 * ### Why role grants stay in `apps/api`
 *
 * The role-to-permission matrix is tightly coupled to the auth pipeline
 * (org membership, API-key creator role ceiling, OIDC scope ceiling) and
 * publishing it from npm would chain every grant change to a
 * `@appstrate/core` republish. Core ships the **vocabulary**; the
 * platform ships the **policy**.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Core resource catalog (static — owned by the platform)
//
// Adding/removing entries here is a coordinated edit:
//   1. Update this interface (compile-time vocabulary)
//   2. Update CORE_RESOURCE_ACTIONS below (runtime mirror) and
//      CORE_RESOURCE_LEVELS (org or space)
//   3. Update apps/api/src/lib/permissions.ts: role grants / space-role
//      presets + API-key allowlist
//
// Drift between (1) and (2) is a TypeScript error (the `satisfies` on the
// runtime table) plus a unit test in core
// (`packages/core/test/permissions.test.ts`) for the per-action half; drift
// between (1) and (3) surfaces immediately as a TypeScript error in the
// role-grant matrix.
// ---------------------------------------------------------------------------

/**
 * Static catalog of core-owned resources. Each property is the resource
 * name; its string-literal-union value enumerates the actions the platform
 * supports for that resource.
 *
 * Lives in `@appstrate/core` so external modules can build typed middleware
 * (`requireCorePermission`) that gates routes on core permissions without
 * importing from `apps/api`.
 */
export interface CoreResources {
  // `update` = name/slug (owner only); `settings` = the per-org settings
  // JSONB (owner + admin). Two actions because the two writes have never
  // had the same audience.
  org: "read" | "update" | "settings" | "delete";
  members: "read" | "invite" | "remove" | "change-role";
  // Custom space-role definitions (org-scoped bundles of space-level
  // permissions). The presets below are code, not rows, and are not
  // reachable through this resource.
  roles: "read" | "write" | "delete";
  // Per-space configuration (name, settings, visibility, default role) —
  // distinct from `spaces`, which is the org-level catalog (list/create/delete).
  "space-settings": "write";
  "space-members": "read" | "invite" | "remove" | "change-role";
  agents: "read" | "write" | "configure" | "delete" | "run";
  skills: "read" | "write" | "delete";
  // AFPS §3.4 — standalone MCP Bundle (MCPB) packages. Browse/import/delete
  // like skills; no editor surface (an mcp-server manifest is an AFPS-native
  // manifest (MCPB vocabulary lifted to the root), authored externally and
  // imported as a `.afps`).
  "mcp-servers": "read" | "write" | "delete";
  runs: "read" | "cancel" | "delete";
  // Durable file store. `read` gates the family the same way `runs:read`
  // gates runs — it answers "may this principal touch files at all",
  // NOT "may it touch THIS file" (the per-file container ACL, derived
  // from the run/chat session at check time, stays the fine-grained layer).
  // Without it a minimally-scoped API key could download every `agent_output`
  // in the space. `delete` is owner/admin, plus the file's own
  // creator (enforced in the route handler, not RBAC).
  files: "read" | "delete";
  schedules: "read" | "write" | "delete";
  // Unified `package_persistence` (checkpoints + memories) with first-class
  // actor scoping. Supersedes the dropped `memories` resource.
  persistence: "read" | "delete";
  models: "read" | "write" | "delete";
  "model-provider-credentials": "read" | "write" | "delete";
  proxies: "read" | "write" | "delete";
  "api-keys": "read" | "create" | "revoke";
  spaces: "read" | "write" | "delete";
  "end-users": "read" | "write" | "delete";
  "credential-proxy": "call";
  "llm-proxy": "call";
  // AFPS integrations (INTEGRATIONS_PROPOSAL Phase 1.3 — marketplace UI).
  // Read = browse catalog + view the actor's connection inventory.
  // Write/delete = author/edit/remove the integration manifest (JSON-body
  // editor, parity with agents/skills). Install/uninstall = manage per-space
  // installation. Connect/disconnect = manage credentials (connections) per
  // declared `auths.{key}`.
  // `configure` covers the space-wide governance surface (per-space
  // integration settings, agent pins, org-default connection). It is
  // deliberately absent from the API-key allowlist: these mutations decide
  // which credential every other principal in the space resolves to, so
  // they stay session-only.
  integrations:
    "read" | "write" | "delete" | "install" | "uninstall" | "configure" | "connect" | "disconnect";
}

/** Core resource names. */
export type CoreResource = keyof CoreResources;

/** Actions available on a given core resource. */
export type CoreAction<R extends CoreResource = CoreResource> = CoreResources[R];

/** All valid core `resource:action` permission strings. */
export type CorePermission = {
  [R in CoreResource]: `${R & string}:${CoreResources[R] & string}`;
}[CoreResource];

/**
 * Runtime mirror of `CoreResources`. The `satisfies` clause makes a missing
 * resource a compile error; a missing *action* is caught by the unit test in
 * `packages/core/test/permissions.test.ts`.
 *
 * The catalog must exist at runtime (not only as a type) because
 * `ORG_LEVEL_PERMISSIONS` / `SPACE_LEVEL_PERMISSIONS` below enumerate every
 * `resource:action` string, and the custom-role validator (§3.3 of the RBAC
 * spec) checks user input against those sets.
 */
export const CORE_RESOURCE_ACTIONS = {
  org: ["read", "update", "settings", "delete"],
  members: ["read", "invite", "remove", "change-role"],
  roles: ["read", "write", "delete"],
  "space-settings": ["write"],
  "space-members": ["read", "invite", "remove", "change-role"],
  agents: ["read", "write", "configure", "delete", "run"],
  skills: ["read", "write", "delete"],
  "mcp-servers": ["read", "write", "delete"],
  runs: ["read", "cancel", "delete"],
  files: ["read", "delete"],
  schedules: ["read", "write", "delete"],
  persistence: ["read", "delete"],
  models: ["read", "write", "delete"],
  "model-provider-credentials": ["read", "write", "delete"],
  proxies: ["read", "write", "delete"],
  "api-keys": ["read", "create", "revoke"],
  spaces: ["read", "write", "delete"],
  "end-users": ["read", "write", "delete"],
  "credential-proxy": ["call"],
  "llm-proxy": ["call"],
  integrations: [
    "read",
    "write",
    "delete",
    "install",
    "uninstall",
    "configure",
    "connect",
    "disconnect",
  ],
} as const satisfies { readonly [R in CoreResource]: readonly CoreResources[R][] };

/**
 * Core resource names. The platform's module loader reads this at boot to
 * reject any module that would re-declare a core resource name in
 * `permissionsContribution()` — without it the collision would only surface
 * as a TypeScript error in apps/api, never for an externally-published module.
 */
export const CORE_RESOURCE_NAMES: ReadonlySet<string> = new Set<string>(
  Object.keys(CORE_RESOURCE_ACTIONS),
);

// ---------------------------------------------------------------------------
// Permission levels (RBAC spec §3.4)
//
// Every permission string belongs to exactly one level. An org role grants
// org-level strings only; a space role grants space-level strings only. The
// level is declared here, next to the resource, so the platform's presets,
// the custom-role validator and any module can all read one source.
// ---------------------------------------------------------------------------

/** Whether a permission is granted by an org role or by a space role. */
export type PermissionLevel = "org" | "space";

/**
 * Level of every core resource. `as const` keeps the literal types so
 * {@link OrgLevelPermission} / {@link SpaceLevelPermission} can be derived
 * from this table rather than re-listed.
 */
export const CORE_RESOURCE_LEVELS = {
  org: "org",
  members: "org",
  roles: "org",
  spaces: "org",
  models: "org",
  "model-provider-credentials": "org",
  proxies: "org",
  // `/api/llm-proxy` is not space-scoped — usage is metered per org.
  "llm-proxy": "org",
  "space-settings": "space",
  "space-members": "space",
  agents: "space",
  skills: "space",
  "mcp-servers": "space",
  runs: "space",
  files: "space",
  schedules: "space",
  persistence: "space",
  "end-users": "space",
  // Keys are space-bound (`api_keys.space_id NOT NULL`).
  "api-keys": "space",
  "credential-proxy": "space",
  integrations: "space",
} as const satisfies Record<CoreResource, PermissionLevel>;

/** Core permission strings granted by org roles. */
export type OrgLevelPermission = {
  [R in CoreResource]: (typeof CORE_RESOURCE_LEVELS)[R] extends "org"
    ? `${R & string}:${CoreResources[R] & string}`
    : never;
}[CoreResource];

/** Core permission strings granted by space roles. */
export type SpaceLevelPermission = {
  [R in CoreResource]: (typeof CORE_RESOURCE_LEVELS)[R] extends "space"
    ? `${R & string}:${CoreResources[R] & string}`
    : never;
}[CoreResource];

/**
 * Enumerate the catalog at one level. The cast is what the level table is
 * for: a resource's level decides which of the two unions its strings belong
 * to, and the table is exhaustive over `CoreResource`.
 */
function corePermissionsAtLevel<P extends CorePermission>(level: PermissionLevel): ReadonlySet<P> {
  const out = new Set<string>();
  for (const [resource, actions] of Object.entries(CORE_RESOURCE_ACTIONS)) {
    if (CORE_RESOURCE_LEVELS[resource as CoreResource] !== level) continue;
    for (const action of actions as readonly string[]) out.add(`${resource}:${action}`);
  }
  return out as ReadonlySet<string> as ReadonlySet<P>;
}

/** Every core permission string at org level. */
export const ORG_LEVEL_PERMISSIONS: ReadonlySet<OrgLevelPermission> = corePermissionsAtLevel("org");

/** Every core permission string at space level. */
export const SPACE_LEVEL_PERMISSIONS: ReadonlySet<SpaceLevelPermission> =
  corePermissionsAtLevel("space");

/**
 * Level of a `resource:action` string, or `undefined` when the string is not
 * a core permission. Module-contributed resources declare their own level in
 * `permissionsContribution()`; this helper answers for the core catalog only.
 */
export function permissionLevel(permission: string): PermissionLevel | undefined {
  const colon = permission.indexOf(":");
  // A bare resource name is not a permission. Without this the `slice` would
  // chop the last character and `"orgs"` would resolve as `"org"`.
  if (colon === -1) return undefined;
  return CORE_RESOURCE_LEVELS[permission.slice(0, colon) as CoreResource];
}

/**
 * Empty extensible interface that modules augment via TypeScript
 * declaration merging. Each key is a resource name, each value is the
 * union of allowed actions.
 *
 * Stays empty in core — every entry comes from an external augmentation.
 * The OSS zero-footprint invariant is preserved: a platform that loads
 * no modules sees `keyof ModuleResources = never`.
 *
 * The empty-object-type lint is intentionally suppressed here: the empty
 * shape IS the contract. Interfaces (not types) are required because only
 * `interface` supports declaration merging from external modules.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ModuleResources {}

/** Resource names contributed by modules. `never` when no module augments. */
export type ModuleResource = keyof ModuleResources;

/** Actions available for a given module-contributed resource. */
export type ModuleAction<R extends ModuleResource = ModuleResource> = ModuleResources[R];

/** All valid `resource:action` permission strings contributed by modules. */
export type ModulePermission = {
  [R in ModuleResource]: `${R & string}:${ModuleResources[R] & string}`;
}[ModuleResource];

// ---------------------------------------------------------------------------
// Org role vocabulary
//
// The literal set of org roles is the single source of truth for both the
// RBAC role-grant matrix (apps/api/src/lib/permissions.ts) and the module
// contribution shape (`ModulePermissionContribution.grantTo` in
// `@appstrate/core/module`). Centralizing it here keeps the type usable from
// every layer that needs to talk about roles — module authors, apps/api,
// shared-types — without each layer redeclaring the union and risking
// drift when a new role is added.
//
// The pgEnum in `packages/db/src/schema/enums.ts` is the runtime DB source
// of truth; `packages/shared-types` reconciles the two with a compile-time
// parity assertion. Adding/removing a role is a 3-place edit (this tuple,
// the pgEnum, the role-grant matrix) — the parity assertion + the
// exhaustive matrix typing make any mismatch a TypeScript error.
// ---------------------------------------------------------------------------

/**
 * Const tuple of org roles. Drives `OrgRole` and the `org_role` pgEnum in
 * `packages/db/src/schema/enums.ts`.
 *
 * `guest` replaced `viewer` in the RBAC space-roles release: read-only-
 * everywhere is a space concern (preset `viewer`), and an org role that
 * implicitly reads every space is exactly what space membership exists to
 * stop. Rows still holding the retired value are refused loudly by
 * `assertOrgRole` in `apps/api/src/lib/permissions.ts` — never mapped.
 */
export const ORG_ROLES = ["owner", "admin", "member", "guest"] as const;

/** Org role string union — `"owner" | "admin" | "member" | "guest"`. */
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * Space-role presets shipped by the platform (RBAC spec §3.3). Constants,
 * not rows: a new space-level permission joins the right preset in the same
 * commit that adds it, with no data migration.
 *
 * Lives in core because modules declare which presets hold their space-level
 * resources (`ModulePermissionContribution.presets`); the preset → permission
 * mapping itself is policy and stays in `apps/api/src/lib/permissions.ts`.
 */
export const SPACE_ROLE_PRESETS = ["admin", "builder", "operator", "viewer"] as const;

/** Space-role preset union — `"admin" | "builder" | "operator" | "viewer"`. */
export type SpaceRolePreset = (typeof SPACE_ROLE_PRESETS)[number];

/**
 * Space visibility (RBAC spec §3.1). `open` — every org `member` is an
 * implicit member with the space's `default_role`; `closed` — listed but
 * enterable only with an explicit `space_members` row; `private` — invisible
 * without a row (404, not 403).
 *
 * Stored as `text` + CHECK rather than a pg enum, like `webhooks.level`:
 * adding a value is a migration either way and text spares the enum rewrite.
 */
export const SPACE_VISIBILITIES = ["open", "closed", "private"] as const;

/** Space visibility union — `"open" | "closed" | "private"`. */
export type SpaceVisibility = (typeof SPACE_VISIBILITIES)[number];

/**
 * One space membership an invitation applies when it is accepted (RBAC spec
 * §5), and the shape `org_invitations.space_assignments` stores.
 *
 * Wire-shaped (snake_case) because it is written straight from the validated
 * invite body and read straight back onto it. Exactly one of `preset_role` /
 * `custom_role_id` is set — the same either/or the `space_members` row is
 * built from, validated at invite time rather than by the type.
 */
export interface SpaceAssignment {
  space_id: string;
  preset_role?: SpaceRolePreset;
  custom_role_id?: string;
}

/** Zod validator for the per-org `settings` JSONB shape. */
export const orgSettingsSchema = z.object({
  api_version: z.string().optional(),
  dashboard_sso_enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Module permission aggregator — runtime registry shared by apps/api and
// modules.
//
// The aggregator lives in core (rather than apps/api) so any module can
// read the merged module-contribution snapshot through a single import
// path — the OIDC module's end-user-scope filter is the canonical
// consumer, and any future module that needs to introspect aggregated
// grants (audit tooling, scope discovery, …) plugs in the same way.
//
// One-way dependency: apps/api's module-loader registers the provider
// here at boot via `setModulePermissionsProvider`; readers below pull
// from the registered provider. Without a registration (no module
// loaded, OSS baseline, unit tests) the readers return the empty
// snapshot, preserving the zero-footprint invariant.
// ---------------------------------------------------------------------------

/**
 * Snapshot of all module-contributed permissions, ready for fast Set
 * lookups. Built once at boot by the module-loader; subsequent reads are
 * pure `Set.has` calls.
 */
export interface ModulePermissionsSnapshot {
  /** Per-org-role module grants (merged into core org grants by apps/api). */
  byRole: Readonly<Record<OrgRole, ReadonlySet<string>>>;
  /** Per-preset module grants (merged into the core space presets by apps/api). */
  byPreset: Readonly<Record<SpaceRolePreset, ReadonlySet<string>>>;
  /** Module entries opted in via `apiKeyGrantable: true`. */
  apiKeyAllowed: ReadonlySet<string>;
  /**
   * Module entries opted in via `endUserGrantable: true`. Read by the
   * OIDC strategy (`apps/api/src/modules/oidc/auth/claims.ts`) to extend
   * the built-in `OIDC_ALLOWED_SCOPES` filter for end-user tokens.
   */
  endUserAllowed: ReadonlySet<string>;
}

const EMPTY_SNAPSHOT: ModulePermissionsSnapshot = {
  byRole: {
    owner: new Set(),
    admin: new Set(),
    member: new Set(),
    guest: new Set(),
  },
  byPreset: {
    admin: new Set(),
    builder: new Set(),
    operator: new Set(),
    viewer: new Set(),
  },
  apiKeyAllowed: new Set(),
  endUserAllowed: new Set(),
};

let _moduleProvider: () => ModulePermissionsSnapshot = () => EMPTY_SNAPSHOT;

/**
 * Register (or clear) the boot-time provider for module-contributed
 * permissions. Called once by apps/api's module-loader after every
 * module has initialized; subsequent calls overwrite the previous
 * provider (intentional — tests use this to inject controlled snapshots,
 * then reset by passing `null`).
 */
export function setModulePermissionsProvider(
  provider: (() => ModulePermissionsSnapshot) | null,
): void {
  _moduleProvider = provider ?? (() => EMPTY_SNAPSHOT);
}

function moduleSnapshot(): ModulePermissionsSnapshot {
  return _moduleProvider();
}

/**
 * Module-contributed grants for `role`. Empty when no module is loaded
 * (OSS baseline) or when no contribution targets the role.
 */
export function getModuleRoleScopes(role: OrgRole): ReadonlySet<string> {
  return moduleSnapshot().byRole[role];
}

/**
 * Module-contributed space-level grants for `preset`. Empty when no module
 * is loaded (OSS baseline) or when no contribution targets the preset.
 */
export function getModulePresetScopes(preset: SpaceRolePreset): ReadonlySet<string> {
  return moduleSnapshot().byPreset[preset];
}

/**
 * Module-contributed permissions opted in via `apiKeyGrantable: true`.
 * Empty when no module is loaded or none opts in. apps/api unions this
 * with its core API-key allowlist via `getApiKeyAllowedScopes()`.
 */
export function getModuleApiKeyScopes(): ReadonlySet<string> {
  return moduleSnapshot().apiKeyAllowed;
}

/**
 * Module-contributed permissions safe to carry on an end-user OIDC
 * token. Read by `apps/api/src/modules/oidc/auth/claims.ts` to extend
 * the built-in `OIDC_ALLOWED_SCOPES` filter for end-user tokens.
 *
 * Empty when no loaded module opts in via `endUserGrantable: true`.
 */
export function getModuleEndUserAllowedScopes(): ReadonlySet<string> {
  return moduleSnapshot().endUserAllowed;
}

// ---------------------------------------------------------------------------
// Hono middleware — typed RBAC guard for module-contributed resources
//
// Imports kept inline (and `any`-typed at the seams) so this file remains
// usable in modules that don't peer-depend on Hono. The runtime contract is
// minimal: the middleware reads `c.get("permissions")` (a `ReadonlySet<string>`
// the platform's auth pipeline writes) and throws an `ApiError` on miss.
// ---------------------------------------------------------------------------

import { forbidden } from "./api-errors.ts";

/**
 * Hono middleware factory that gates a route on a module-contributed
 * `resource:action` permission. Strongly typed against the
 * `ModuleResources` augmentation surface — call sites recover
 * full literal narrowing once a module declares its resources:
 *
 * ```ts
 * declare module "@appstrate/core/permissions" {
 *   interface ModuleResources { tasks: "read" | "write" }
 * }
 *
 * router.get(
 *   "/api/tasks",
 *   requireModulePermission("tasks", "read"), // ← typechecked
 *   handler,
 * );
 * ```
 *
 * Why this lives in core rather than being re-exported by the platform:
 *   1. Module authors should not need an internal `apps/api/*` import to
 *      enforce their own permissions — that re-creates the coupling
 *      problem the RBAC extension surface was built to solve.
 *   2. The check is purely Set membership on `c.get("permissions")`, which
 *      the platform's auth pipeline always writes (cookie, API key, OIDC
 *      strategies). No core-only types are touched.
 *   3. Typing is keyed on `ModuleResources` only — the helper is
 *      deliberately scoped to module-contributed resources. Core resources
 *      (`agents`, `webhooks`, …) are gated by the platform's own
 *      `requirePermission()` middleware, which lives where the core
 *      `Permission` union is defined.
 *
 * The runtime guard is fail-closed: missing permissions Set, missing entry,
 * or non-Set value all throw `forbidden()`. Audit logging is delegated via
 * `setPermissionDenialHandler` — the platform registers its logger at
 * boot and every denial (from `requireModulePermission`,
 * `requireCorePermission`, and any apps/api-internal wrapper) flows
 * through the same handler. Modules do not need to wire their own logger.
 */
export function requireModulePermission<R extends ModuleResource>(
  resource: R,
  action: ModuleAction<R>,
): (c: HonoContextLike, next: HonoNextLike) => Promise<unknown> {
  return makePermissionGuard(`${resource as string}:${action as string}`);
}

/**
 * Hono middleware factory that gates a route on a **core** permission —
 * the symmetrical helper to `requireModulePermission`, typed against
 * `CoreResources` instead.
 *
 * Modules consume this when they need to gate a route on a core resource
 * they don't own (e.g. a downstream module checking `agents:run` before
 * dispatching work). Without this helper, modules had to either
 * (a) reach into `apps/api/src/middleware/require-permission.ts` — an
 * internal package they cannot import — or (b) hand-roll a stringly-typed
 * check that drifts the day core renames an action.
 *
 * Same fail-closed semantics as `requireModulePermission`: missing
 * permissions Set, missing entry, or non-Set value all throw `forbidden()`.
 *
 * ```ts
 * import { requireCorePermission } from "@appstrate/core/permissions";
 *
 * router.post(
 *   "/api/tasks/runs/:runId/cancel",
 *   requireCorePermission("agents", "run"), // ← typechecked
 *   handler,
 * );
 * ```
 *
 * Note: the platform's own `apps/api/src/middleware/require-permission.ts`
 * exposes a *unified* `requirePermission` middleware whose `Resource` type
 * is the union of core + module-augmented resources. That helper is
 * apps/api-internal and stays so — modules use this typed helper for core
 * resources and `requireModulePermission` for their own.
 */
export function requireCorePermission<R extends CoreResource>(
  resource: R,
  action: CoreAction<R>,
): (c: HonoContextLike, next: HonoNextLike) => Promise<unknown> {
  return makePermissionGuard(`${resource as string}:${action as string}`);
}

// ---------------------------------------------------------------------------
// Space context for module routes
//
// A module that gates a SPACE-level resource on a route family the platform
// does not space-scope (`SPACE_SCOPED_PREFIXES` is core-only by design) has to
// enter the space itself: org-level permissions can never carry a space-level
// string, so its guard would otherwise be unsatisfiable — fail-closed, and the
// wrong answer. `enterSpaceContext` is the seam it calls. The platform
// registers the implementation at boot, exactly as it registers the module
// permission provider and the denial handler above.
// ---------------------------------------------------------------------------

/**
 * Resolve a space for the request and rewrite `permissions` to the caller's
 * effective set in it. `spaceId` is optional: omitted, the platform resolves
 * the pinned space, then `X-Space-Id`, then the org's default.
 */
type SpaceContextApplier = (c: HonoContextLike, spaceId?: string) => Promise<void>;

let _spaceContextApplier: SpaceContextApplier | null = null;

/**
 * Register (or clear) the platform's space-context applier. Called once by
 * apps/api; passing `null` restores the unregistered state.
 */
export function setSpaceContextApplier(applier: SpaceContextApplier | null): void {
  _spaceContextApplier = applier;
}

/**
 * Enter a space for this request, so a space-level `requireModulePermission`
 * downstream reads the caller's set IN that space (RBAC spec §4.3).
 *
 * Throws whatever the platform's resolver throws — 403 `not_a_space_member`
 * for an `open`/`closed` space the caller is not in, 404 for a `private` one.
 *
 * @throws Error when no platform registered an applier. Deliberately loud: a
 *   silent no-op would leave every guarded route in the module 403-ing with no
 *   indication that the seam was never wired.
 */
export async function enterSpaceContext(c: HonoContextLike, spaceId?: string): Promise<void> {
  if (!_spaceContextApplier) {
    throw new Error(
      "enterSpaceContext: no space-context applier registered. The platform wires one at boot; " +
        "a module cannot resolve a space on its own.",
    );
  }
  await _spaceContextApplier(c, spaceId);
}

// ---------------------------------------------------------------------------
// Shared guard + audit-hook
//
// `makePermissionGuard` is the single runtime path for every typed RBAC
// middleware in the repo: `requireCorePermission`, `requireModulePermission`,
// and the apps/api-internal union-typed `requirePermission` all build on it.
// Keeping one code path guarantees that audit logging, fail-closed semantics,
// and error shape stay identical across core and module routes. The typed
// wrappers above remain separate functions only so each can be keyed against
// its own resource catalog — a single overloaded export would force callers
// to provide the union type explicitly to recover narrowing.
// ---------------------------------------------------------------------------

/**
 * Context passed to a `PermissionDenialHandler` when a guard denies a
 * request. `c` is the Hono context (typed as `HonoContextLike` here to
 * avoid pulling `hono` into core's TS graph — apps/api casts internally to
 * its concrete `Context<AppEnv>` shape).
 */
export interface PermissionDenialContext {
  required: string;
  c: HonoContextLike;
}

type PermissionDenialHandler = (ctx: PermissionDenialContext) => void;

let _denialHandler: PermissionDenialHandler | null = null;

/**
 * Register (or clear) the audit handler invoked by `makePermissionGuard`
 * every time a guarded route denies a request. The platform registers its
 * logger at boot so module-route denials are audited with the same
 * metadata shape (actor, org, role, path, required permission) as
 * core-route denials. Mirrors the `setModulePermissionsProvider` pattern:
 * a one-way dependency from apps/api to core, no cyclic import.
 *
 * Passing `null` restores the default no-op handler — used by tests that
 * want to silence audit noise.
 */
export function setPermissionDenialHandler(handler: PermissionDenialHandler | null): void {
  _denialHandler = handler;
}

/**
 * Build a Hono middleware that gates a route on `required` (shape:
 * `resource:action`). Shared runtime path for `requirePermission`,
 * `requireCorePermission`, and `requireModulePermission` — any divergence
 * (logging, error shape, fail-closed checks) would silently drift
 * core-route audits away from module-route audits.
 *
 * @internal Not part of the stable module-author contract. Module code
 * should use the typed `requireCorePermission` / `requireModulePermission`
 * helpers instead — those recover literal-narrowing against
 * `CoreResources` / `ModuleResources` and catch typos
 * at compile time. Calling `makePermissionGuard` directly bypasses that
 * check: a bad string compiles, runs, and silently denies every request.
 * Kept `export` (not underscore-prefixed) so apps/api can reuse the exact
 * same runtime path under its own union-typed wrapper.
 */
export function makePermissionGuard(
  required: string,
): (c: HonoContextLike, next: HonoNextLike) => Promise<unknown> {
  return async (c, next) => {
    const perms = c.get("permissions") as ReadonlySet<string> | undefined;
    const granted = !!perms && typeof perms.has === "function" && perms.has(required);
    if (!granted) {
      // Audit is best-effort — a throwing handler must not escalate an
      // authz denial into a 500 (which would leak timing info and, worse,
      // mask the 403 in the error-handler's generic path). Catch + swallow
      // + continue to throw `forbidden` deterministically.
      if (_denialHandler) {
        try {
          _denialHandler({ required, c });
        } catch {
          // Deliberately swallowed — we cannot log from core (no logger
          // wired at this layer) and bubbling would break the fail-closed
          // contract. Operators see the 403 in request logs either way.
        }
      }
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  };
}

/**
 * Minimal Hono context shape used by `makePermissionGuard` /
 * `requireModulePermission` / `requireCorePermission`. Declared inline so
 * this file does not pull `hono` types into core's TS graph (Hono is a
 * peer dependency, optional for module consumers that only need the
 * type-level surface). `get(string)` returns `unknown` so the audit
 * handler registered from apps/api can cast to its own `Context<AppEnv>`
 * shape without core depending on it.
 */
export interface HonoContextLike {
  get(key: string): unknown;
}
type HonoNextLike = () => Promise<unknown>;
