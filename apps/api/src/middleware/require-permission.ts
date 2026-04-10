// SPDX-License-Identifier: Apache-2.0

/**
 * Unified permission middleware.
 *
 * Checks `c.get("permissions")` (a Set<string> resolved earlier in the auth pipeline)
 * against the required `resource:action`. Logs denied attempts for audit.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §4.3
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { forbidden } from "../lib/errors.ts";
import type { Resource, Action } from "../lib/permissions.ts";
import { logger } from "../lib/logger.ts";

/**
 * Middleware factory: require a specific permission.
 *
 * Usage: `router.post("/path", requirePermission("agents", "write"), handler)`
 */
export function requirePermission<R extends Resource>(resource: R, action: Action<R>) {
  const required = `${resource}:${action}`;
  return async (c: Context<AppEnv>, next: Next) => {
    const permissions = c.get("permissions");
    if (!permissions || !permissions.has(required)) {
      logger.warn("permission_denied", {
        actorId: c.get("user")?.id,
        orgId: c.get("orgId"),
        authMode: c.get("authMethod"),
        required,
        role: c.get("orgRole"),
        path: `${c.req.method} ${c.req.path}`,
        ...(c.get("apiKeyId") ? { apiKeyId: c.get("apiKeyId") } : {}),
      });
      throw forbidden(`Insufficient permissions: ${required} required`);
    }
    return next();
  };
}
