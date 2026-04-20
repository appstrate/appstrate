// SPDX-License-Identifier: Apache-2.0

/**
 * Audit logger for RBAC denials.
 *
 * The core `makePermissionGuard` (used by `requirePermission`,
 * `requireCorePermission`, and `requireModulePermission`) delegates audit
 * logging to a handler registered via `setPermissionDenialHandler`. The
 * platform registers the handler below at boot so every denial — from any
 * of the three typed front-doors — produces an identically-shaped
 * `permission_denied` event: same fields, same log level, same source.
 *
 * Why this lives in apps/api rather than in core:
 *   - Core must stay dependency-light (no `hono`, no pino pretty printer,
 *     no app-specific context shape). The handler casts the opaque
 *     `HonoContextLike` to our concrete `Context<AppEnv>` at the boundary.
 *   - The logger is the platform's pino instance, not a module-supplied
 *     one — audit trails belong to the platform operator, not to the
 *     module that happens to own the denied resource.
 */

import type { Context } from "hono";
import type { PermissionDenialContext } from "@appstrate/core/permissions";
import { setPermissionDenialHandler } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import { logger } from "./logger.ts";

/**
 * Install the audit handler. Idempotent — subsequent calls replace the
 * previous handler (tests use this to silence noise).
 */
export function installPermissionAuditLogger(): void {
  setPermissionDenialHandler((ctx: PermissionDenialContext) => {
    const c = ctx.c as Context<AppEnv>;
    logger.warn("permission_denied", {
      actorId: c.get("user")?.id,
      orgId: c.get("orgId"),
      authMode: c.get("authMethod"),
      required: ctx.required,
      role: c.get("orgRole"),
      path: `${c.req.method} ${c.req.path}`,
      ...(c.get("apiKeyId") ? { apiKeyId: c.get("apiKeyId") } : {}),
    });
  });
}
