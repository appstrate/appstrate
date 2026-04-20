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
