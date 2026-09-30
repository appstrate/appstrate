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
import {
  makePermissionGuard,
  PERMISSION_REQUIREMENT_MARKER,
  reportPermissionDenial,
} from "@appstrate/core/permissions";
import { forbidden } from "../lib/errors.ts";
import { ceilingAllows, type Resource, type Action, type Permission } from "../lib/permissions.ts";
import { hasHandlerMarker, markHandler, readHandlerMarker } from "./handler-marker.ts";

/** Stamped by every route-level permission guard (core's `makePermissionGuard`
 *  stamps it too). */
export const PERMISSION_GUARD = Symbol.for("appstrate.permissionGuard");

/** True when `handler` is a permission guard. No production caller: it exists for
 *  the agent-lookup ordering conformance test
 *  (`test/integration/middleware/agent-lookup-permission-order.test.ts`). */
export function isPermissionGuard(handler: unknown): boolean {
  return hasHandlerMarker(handler, PERMISSION_GUARD);
}

const SPACE_RESCOPE = Symbol.for("appstrate.spaceRescope");

/** Mark a middleware that re-applies `permissions` for a space the PATH names,
 *  so guards mounted after it are enforced in that space, not the caller's. */
export function markSpaceRescope<T extends object>(handler: T): T {
  return markHandler(handler, SPACE_RESCOPE);
}

export function isSpaceRescope(handler: unknown): boolean {
  return hasHandlerMarker(handler, SPACE_RESCOPE);
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
 * The joined form is also the requirement stamped for `lib/route-requirements.ts`.
 * An empty list throws: it would deny everyone yet stamp `""`, read as a grant.
 */
export function requireAnyPermission(permissions: readonly string[]) {
  if (permissions.length === 0) {
    throw new Error("requireAnyPermission() needs at least one permission");
  }
  const required = permissions.join("|");
  const guard = markHandler(async (c: Context<AppEnv>, next: Next) => {
    const held = c.get("permissions");
    if (!permissions.some((permission) => held?.has(permission))) {
      reportPermissionDenial(c, required);
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  }, PERMISSION_GUARD);
  return markHandler(guard, PERMISSION_REQUIREMENT_MARKER, required);
}

const CEILING_REQUIREMENT = Symbol.for("appstrate.ceilingRequirement");

/**
 * Middleware factory: cap an act authorized by OWNERSHIP with the credential's
 * scope ceiling. Not a role grant — a caller without the permission still acts
 * on what it owns, so `permissions` is not consulted; only a delegated
 * credential (API key, OIDC token) whose ceiling omits it is refused, with the
 * same audit hook and 403 as {@link requirePermission} (RBAC spec §7.1).
 * A cookie session carries no ceiling and always passes.
 */
export function requireCeiling<R extends Resource>(resource: R, action: Action<R>) {
  const required = `${resource as string}:${action as string}`;
  const guard = async (c: Context<AppEnv>, next: Next) => {
    if (!ceilingAllows(c, required as Permission)) {
      reportPermissionDenial(c, required);
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  };
  return markHandler(guard, CEILING_REQUIREMENT, required);
}

/**
 * {@link requireCeiling} over a disjunction: the ceiling must include ANY ONE
 * of `permissions`. Recorded as the alternatives joined with `|`, as
 * {@link requireAnyPermission} records its own. An empty list throws.
 */
export function requireAnyCeiling(permissions: readonly Permission[]) {
  if (permissions.length === 0) {
    throw new Error("requireAnyCeiling() needs at least one permission");
  }
  const required = permissions.join("|");
  const guard = async (c: Context<AppEnv>, next: Next) => {
    if (!permissions.some((permission) => ceilingAllows(c, permission))) {
      reportPermissionDenial(c, required);
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  };
  return markHandler(guard, CEILING_REQUIREMENT, required);
}

/** What a ceiling guard caps with (`a|b` for a disjunction), or `null` for any other handler. */
export function ceilingRequirementOf(handler: unknown): string | null {
  const required = readHandlerMarker(handler, CEILING_REQUIREMENT);
  return typeof required === "string" ? required : null;
}
