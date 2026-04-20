// SPDX-License-Identifier: Apache-2.0

/**
 * Unified permission middleware — apps/api-internal wrapper around the
 * shared RBAC guard in `@appstrate/core/permissions`.
 *
 * Core and module routes converge on `makePermissionGuard` from core:
 * same fail-closed semantics, same error shape, same audit hook. This
 * file exists so core-route call sites can keep their union-typed
 * ergonomics (`requirePermission("agents", "read")` narrows `action` on
 * the core resource surface) while sharing the runtime with
 * `requireCorePermission` / `requireModulePermission`.
 *
 * Audit logging is registered once at boot via
 * `setPermissionDenialHandler` — see `apps/api/src/lib/permission-audit.ts`.
 * Do not log denials here: that would double-log for core routes and
 * leave module-route denials unaudited.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §4.3
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { makePermissionGuard } from "@appstrate/core/permissions";
import type { Resource, Action } from "../lib/permissions.ts";

/**
 * Middleware factory: require a specific permission.
 *
 * Usage: `router.post("/path", requirePermission("agents", "write"), handler)`
 */
export function requirePermission<R extends Resource>(resource: R, action: Action<R>) {
  const guard = makePermissionGuard(`${resource as string}:${action as string}`);
  return (c: Context<AppEnv>, next: Next) => guard(c, next);
}
