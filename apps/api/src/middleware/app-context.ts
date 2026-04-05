// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { invalidRequest, notFound } from "../lib/errors.ts";

/**
 * Middleware: resolve application context for app-scoped routes.
 *
 * Resolution order:
 * 1. X-App-Id header (session auth — dashboard users)
 * 2. applicationId from API key (already set by auth middleware)
 *
 * Validates that the application belongs to the current org.
 * Sets c.set("applicationId") and c.set("appIsDefault") on success.
 */
export function requireAppContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    // Resolution order: X-App-Id header (session auth) → applicationId from API key auth
    const appId = c.req.header("X-App-Id") ?? c.get("applicationId");

    if (!appId) {
      throw invalidRequest(
        "Application context required. Provide X-App-Id header or use an API key.",
        "X-App-Id",
      );
    }

    const orgId = c.get("orgId");

    const [app] = await db
      .select({ id: applications.id, isDefault: applications.isDefault })
      .from(applications)
      .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)))
      .limit(1);

    if (!app) {
      throw notFound(`Application '${appId}' not found in this organization`);
    }

    c.set("applicationId", appId);
    c.set("appIsDefault", app.isDefault);
    return next();
  };
}
