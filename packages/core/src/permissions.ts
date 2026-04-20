// SPDX-License-Identifier: Apache-2.0

/**
 * Module-extensible RBAC contract.
 *
 * Core RBAC (resources + role grants + API-key allowlist) lives in the
 * platform under `apps/api/src/lib/permissions.ts` — that's where it must
 * stay because (a) the role grants are tightly coupled to the auth
 * pipeline and (b) shipping the catalog from npm would chain every
 * permission addition to a `@appstrate/core` republish.
 *
 * What this file provides instead is a **declaration-merging extension
 * point** so external modules can teach the platform about their own
 * resources without forking core or hand-rolling a permission middleware:
 *
 * ```ts
 * // External module
 * declare module "@appstrate/core/permissions" {
 *   interface AppstrateModuleResources {
 *     chat: "read" | "write";
 *   }
 * }
 *
 * // Anywhere consumers want compile-time narrowing
 * import type { ModuleResource } from "@appstrate/core/permissions";
 * type R = ModuleResource; // "chat"
 * ```
 *
 * The platform widens its own `Resource` union with `keyof
 * AppstrateModuleResources` so `requirePermission("chat", "read")` becomes
 * type-safe end-to-end — no casts, no string-typed escape hatches.
 *
 * Runtime contribution (which permissions exist and how roles grant them)
 * is declared by the module via `AppstrateModule.permissionsContribution()`
 * — see `@appstrate/core/module`. The declaration-merging surface here
 * mirrors that runtime contract at the type level.
 */

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
  const required = `${resource as string}:${action as string}`;
  return async (c, next) => {
    const perms = c.get("permissions") as ReadonlySet<string> | undefined;
    if (!perms || typeof perms.has !== "function" || !perms.has(required)) {
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  };
}

/**
 * Minimal Hono context shape used by `requireModulePermission`. Declared
 * inline so this file does not pull `hono` types into core's TS graph
 * (Hono is a peer dependency, optional for module consumers that only
 * need the type-level surface).
 */
interface HonoContextLike {
  get(key: "permissions"): unknown;
}
type HonoNextLike = () => Promise<unknown>;
