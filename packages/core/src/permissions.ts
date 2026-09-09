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
//   2. Update CORE_RESOURCE_ACTIONS (runtime mirror) + CORE_RESOURCE_LEVELS
//   3. Update apps/api/src/lib/permissions.ts (role grants / presets + API-key allowlist)
//
// (1)↔(2) drift is a TypeScript error (`satisfies`) plus a core unit test;
// (1)↔(3) drift is a TypeScript error in the role-grant matrix.
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
  // `update` = name/slug (owner only); `settings` = the per-org settings JSONB (owner + admin).
  org: "read" | "update" | "settings" | "delete";
  members: "read" | "invite" | "remove" | "change-role";
  // Custom space-role definitions; the presets are code, not rows, and not reachable here.
  roles: "read" | "write" | "delete";
  // Per-space configuration; `spaces` is the org-level catalog.
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
  // `configure` (per-space integration settings, agent pins, org-default connection) is
  // deliberately absent from the API-key allowlist: it decides which credential every
  // other principal in the space resolves to, so it stays session-only.
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
 * Runtime mirror of `CoreResources`: `satisfies` catches a missing resource,
 * `packages/core/test/permissions.test.ts` a missing action. Needed at runtime because
 * the level sets below and the custom-role validator (RBAC spec §3.3) enumerate it.
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

/** Read by the module loader at boot to refuse a module re-declaring a core resource name. */
export const CORE_RESOURCE_NAMES: ReadonlySet<string> = new Set<string>(
  Object.keys(CORE_RESOURCE_ACTIONS),
);

// ---------------------------------------------------------------------------
// Permission levels (RBAC spec §3.4) — every permission string belongs to
// exactly one level: org roles grant org-level strings only, space roles
// space-level strings only.
// ---------------------------------------------------------------------------

/** Whether a permission is granted by an org role or by a space role. */
export type PermissionLevel = "org" | "space";

/** Level of every core resource; `as const` so the level unions below derive from it. */
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

/** Enumerate the catalog at one level; the cast is what the exhaustive level table licenses. */
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
 * Const tuple of org roles; drives `OrgRole` and the `org_role` pgEnum. `guest` has no
 * implicit space access — read-only-everywhere is the space preset `viewer`, not an org role.
 */
export const ORG_ROLES = ["owner", "admin", "member", "guest"] as const;

/** Org role string union — `"owner" | "admin" | "member" | "guest"`. */
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * Space-role presets (RBAC spec §3.3). Constants, not rows. In core so modules can name
 * them in `ModulePermissionContribution.presets`; the preset → permission mapping is
 * policy and stays in `apps/api/src/lib/permissions.ts`.
 * Ordered strongest first — `assertPresetsUpwardClosed` reads the tuple in order.
 */
export const SPACE_ROLE_PRESETS = ["admin", "builder", "operator", "viewer"] as const;

/** Space-role preset union — `"admin" | "builder" | "operator" | "viewer"`. */
export type SpaceRolePreset = (typeof SPACE_ROLE_PRESETS)[number];

/** Org roles holding every org-level permission in every space, without a `space_members` row. */
export const ORG_ROLES_WITH_FULL_ACCESS = ["owner", "admin"] as const;

export type OrgRoleWithFullAccess = (typeof ORG_ROLES_WITH_FULL_ACCESS)[number];

/**
 * Space visibility (RBAC spec §3.1): `open` — every org `member` is an implicit member
 * with the space's `default_role`; `closed` — listed, entered only with a `space_members`
 * row; `private` — invisible without a row (404, not 403).
 */
export const SPACE_VISIBILITIES = ["open", "closed", "private"] as const;

/** Space visibility union — `"open" | "closed" | "private"`. */
export type SpaceVisibility = (typeof SPACE_VISIBILITIES)[number];

/**
 * One space membership applied when an invitation is accepted (RBAC spec §5); the shape
 * `org_invitations.space_assignments` stores, hence snake_case. Exactly one of
 * `preset_role` / `custom_role_id` is set (validated at invite time, not by the type).
 */
export interface SpaceAssignment {
  space_id: string;
  preset_role?: SpaceRolePreset;
  custom_role_id?: string;
}

// ---------------------------------------------------------------------------
// "View as role" wire contract — shared by the API, the SPA and the chat module
// so a carrier renamed on one side is a compile error, not a persona silently
// ignored.
// ---------------------------------------------------------------------------

/** Org roles a preview may take — the complement of {@link ORG_ROLES_WITH_FULL_ACCESS}. */
export type ViewAsOrgRole = Exclude<OrgRole, OrgRoleWithFullAccess>;

export const VIEW_AS_ORG_ROLES: readonly [ViewAsOrgRole, ...ViewAsOrgRole[]] = ORG_ROLES.filter(
  (role): role is ViewAsOrgRole =>
    !(ORG_ROLES_WITH_FULL_ACCESS as readonly OrgRole[]).includes(role),
) as [ViewAsOrgRole, ...ViewAsOrgRole[]];

/** HTTP carrier: `org_role=…; space=…; role=preset:…|custom:…`. */
export const VIEW_AS_HEADER = "X-View-As";

/** Same grammar, as a query parameter — `EventSource` cannot send headers. */
export const VIEW_AS_QUERY = "view_as";

/**
 * Stamped on every response produced under a validated persona, and only then — for
 * clients that cannot see the SPA store (e2e, CLI, out-of-tree) to tell a persona's 403 apart.
 */
export const VIEW_AS_ACTIVE_HEADER = "X-View-As-Active";

/**
 * Problem codes meaning the PERSONA was refused (not that it lacked a permission).
 * A client seeing one must drop the preview rather than retry without it.
 */
export const VIEW_AS_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "invalid_view_as",
  "view_as_unsupported",
  "view_as_forbidden",
  "view_as_not_found",
]);

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

/** Module-contributed space-level grants for `preset`; empty when no module targets it. */
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
// Space context for module routes — a module gating a SPACE-level resource on a
// route family the platform does not space-scope must enter the space itself:
// an org-level set never carries a space-level string, so its guard would be
// unsatisfiable. The platform registers the applier at boot.
// ---------------------------------------------------------------------------

/** `spaceId` omitted: the platform resolves the pinned space, then `X-Space-Id`, then the org default. */
type SpaceContextApplier = (c: HonoContextLike, spaceId?: string) => Promise<void>;

let _spaceContextApplier: SpaceContextApplier | null = null;

/** Platform boot wiring; `null` restores the unregistered state. */
export function setSpaceContextApplier(applier: SpaceContextApplier | null): void {
  _spaceContextApplier = applier;
}

/**
 * Enter a space for this request so a downstream space-level guard reads the caller's
 * set IN that space (RBAC spec §4.3). Throws what the platform's resolver throws (403
 * `not_a_space_member`, 404 for a `private` space) and, deliberately loud, when no
 * applier is registered — a silent no-op would 403 every guarded route.
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
      reportPermissionDenial(c, required);
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  };
}

/**
 * Fire the denial audit hook for a refusal decided outside `makePermissionGuard` (a
 * disjunction one guard cannot express — pass the alternatives joined with `|`).
 * A throwing handler is swallowed: it must not turn a 403 into a 500.
 */
export function reportPermissionDenial(c: HonoContextLike, required: string): void {
  if (!_denialHandler) return;
  try {
    _denialHandler({ required, c });
  } catch {
    // see above
  }
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
