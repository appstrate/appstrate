// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC contract — core resource catalog + module extension point.
 *
 * This file owns two surfaces that together let any code (in core, in the
 * platform, or in an external module) talk about Appstrate permissions
 * with full TypeScript narrowing:
 *
 *   1. `AppstrateCoreResources` — the **static** catalog of resources the
 *      platform itself ships. Adding a new core resource is an edit here
 *      (interface property) plus an edit in
 *      `apps/api/src/lib/permissions.ts` (role grants + API-key allowlist).
 *      The interface lives in core so that external modules can build
 *      typed middleware against it (see `requireCorePermission` below)
 *      without reaching into `apps/api`.
 *
 *   2. `AppstrateModuleResources` — the **extensible** catalog modules
 *      augment via TypeScript declaration merging. Each augmenting module
 *      pairs the type-level `declare module` with a runtime
 *      `AppstrateModule.permissionsContribution()` so the platform's
 *      role-grant matrix and API-key allowlist pick the new resource up
 *      at boot.
 *
 * The platform's `Resource` / `Permission` union (in
 * `apps/api/src/lib/permissions.ts`) is the union of both surfaces — call
 * sites like `requirePermission("agents", "read")` and
 * `requirePermission("chat", "read")` work uniformly regardless of origin.
 *
 * ### Why role grants stay in `apps/api`
 *
 * The role-to-permission matrix is tightly coupled to the auth pipeline
 * (org membership, API-key creator role ceiling, OIDC scope ceiling) and
 * publishing it from npm would chain every grant change to a
 * `@appstrate/core` republish. Core ships the **vocabulary**; the
 * platform ships the **policy**.
 */

// ---------------------------------------------------------------------------
// Core resource catalog (static — owned by the platform)
//
// Adding/removing entries here is a coordinated edit:
//   1. Update this interface (compile-time vocabulary)
//   2. Update CORE_RESOURCE_NAMES below (runtime collision-detection set)
//   3. Update apps/api/src/lib/permissions.ts: role grants + API-key allowlist
//
// Drift between (1) and (2) is caught by a unit test in core
// (`packages/core/test/permissions.test.ts`) and drift between (1) and (3)
// surfaces immediately as a TypeScript error in the role-grant matrix.
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
export interface AppstrateCoreResources {
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

/** Core resource names. */
export type CoreResource = keyof AppstrateCoreResources;

/** Actions available on a given core resource. */
export type CoreAction<R extends CoreResource = CoreResource> = AppstrateCoreResources[R];

/** All valid core `resource:action` permission strings. */
export type CorePermission = {
  [R in CoreResource]: `${R & string}:${AppstrateCoreResources[R] & string}`;
}[CoreResource];

/**
 * Runtime mirror of `keyof AppstrateCoreResources`. The platform's module
 * loader reads this at boot to reject any module that would re-declare a
 * core resource name in `permissionsContribution()` — without it the
 * collision would only surface as a TypeScript error in apps/api, never
 * for an externally-published module.
 *
 * Drift with the interface above is caught by a unit test in
 * `packages/core/test/permissions.test.ts` (`AppstrateCoreResources matches
 * CORE_RESOURCE_NAMES`) — keep both in sync when adding a resource.
 */
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

/**
 * Empty extensible interface that modules augment via TypeScript
 * declaration merging. Each key is a resource name, each value is the
 * union of allowed actions.
 *
 * Stays empty in core — every entry comes from an external augmentation.
 * The OSS zero-footprint invariant is preserved: a platform that loads
 * no modules sees `keyof AppstrateModuleResources = never`.
 *
 * The empty-object-type lint is intentionally suppressed here: the empty
 * shape IS the contract. Interfaces (not types) are required because only
 * `interface` supports declaration merging from external modules.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppstrateModuleResources {}

/** Resource names contributed by modules. `never` when no module augments. */
export type ModuleResource = keyof AppstrateModuleResources;

/** Actions available for a given module-contributed resource. */
export type ModuleAction<R extends ModuleResource = ModuleResource> = AppstrateModuleResources[R];

/** All valid `resource:action` permission strings contributed by modules. */
export type ModulePermission = {
  [R in ModuleResource]: `${R & string}:${AppstrateModuleResources[R] & string}`;
}[ModuleResource];

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
 * `AppstrateModuleResources` augmentation surface — call sites recover
 * full literal narrowing once a module declares its resources:
 *
 * ```ts
 * declare module "@appstrate/core/permissions" {
 *   interface AppstrateModuleResources { chat: "read" | "write" }
 * }
 *
 * router.get(
 *   "/api/chat/sessions",
 *   requireModulePermission("chat", "read"), // ← typechecked
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
 *   3. Typing is keyed on `AppstrateModuleResources` only — the helper is
 *      deliberately scoped to module-contributed resources. Core resources
 *      (`agents`, `webhooks`, …) are gated by the platform's own
 *      `requirePermission()` middleware, which lives where the core
 *      `Permission` union is defined.
 *
 * The runtime guard is fail-closed: missing permissions Set, missing entry,
 * or non-Set value all throw `forbidden()`. Logging is intentionally NOT
 * done here — modules pick their own logger via `PlatformServices.logger`
 * after the throw is caught upstream (or rely on the platform's global
 * error handler).
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
 * `AppstrateCoreResources` instead.
 *
 * Modules consume this when they need to gate a route on a core resource
 * they don't own (e.g. a chat module checking `agents:run` before
 * dispatching a turn). Without this helper, modules had to either
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
 *   "/api/chat/runs/:runId/cancel",
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

/**
 * Shared implementation for `requireModulePermission` and
 * `requireCorePermission`. Kept private so the two public middlewares
 * remain typed independently against their respective resource catalogs —
 * a single overloaded export would force callers to provide the union
 * type explicitly to recover narrowing.
 */
function makePermissionGuard(
  required: string,
): (c: HonoContextLike, next: HonoNextLike) => Promise<unknown> {
  return async (c, next) => {
    const perms = c.get("permissions") as ReadonlySet<string> | undefined;
    if (!perms || typeof perms.has !== "function" || !perms.has(required)) {
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  };
}

/**
 * Minimal Hono context shape used by `requireModulePermission` /
 * `requireCorePermission`. Declared inline so this file does not pull
 * `hono` types into core's TS graph (Hono is a peer dependency, optional
 * for module consumers that only need the type-level surface).
 */
interface HonoContextLike {
  get(key: "permissions"): unknown;
}
type HonoNextLike = () => Promise<unknown>;
