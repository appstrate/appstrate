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
import { makePermissionGuard, reportPermissionDenial } from "@appstrate/core/permissions";
import { forbidden } from "../lib/errors.ts";
import type { Resource, Action } from "../lib/permissions.ts";
import { hasHandlerMarker, markHandler } from "./handler-marker.ts";

/** Stamped by every route-level permission guard (core's `makePermissionGuard`
 *  stamps it too). Read by the agent-lookup ordering conformance test. */
const PERMISSION_GUARD = Symbol.for("appstrate.permissionGuard");

/** True when `handler` is a route-level permission guard, i.e. it 403s a
 *  caller lacking the permission before the handler chain continues. */
export function isPermissionGuard(handler: unknown): boolean {
  return hasHandlerMarker(handler, PERMISSION_GUARD);
}

/**
 * Middleware factory: require a specific permission.
 *
 * Usage: `router.post("/path", requirePermission("agents", "write"), handler)`
 */
export function requirePermission<R extends Resource>(resource: R, action: Action<R>) {
  return makePermissionGuard(`${resource as string}:${action as string}`);
}

/**
 * Assert a permission from inside a handler — same audit hook and same 403 as
 * {@link requirePermission}, for a check that can only run once a row is loaded.
 */
export function assertPermission<R extends Resource>(
  c: Context<AppEnv>,
  resource: R,
  action: Action<R>,
): void {
  const required = `${resource as string}:${action as string}`;
  if (c.get("permissions")?.has(required)) return;
  reportPermissionDenial(c, required);
  throw forbidden(`Insufficient permissions: ${required} required`);
}

/**
 * Middleware factory: require ANY ONE of several permissions.
 *
 * A single `makePermissionGuard` cannot express a disjunction, so the denial
 * is decided here and the audit records the alternatives joined with `|` —
 * what the caller would have needed, not an arbitrary pick from the list.
 * Handlers that resolve the disjunction only once the row is loaded invoke it
 * with a no-op `next`, the same way route-level guards are reused inline.
 */
export function requireAnyPermission(permissions: readonly string[]) {
  const required = permissions.join("|");
  return markHandler(async (c: Context<AppEnv>, next: Next) => {
    const held = c.get("permissions");
    if (!permissions.some((permission) => held?.has(permission))) {
      reportPermissionDenial(c, required);
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  }, PERMISSION_GUARD);
}
