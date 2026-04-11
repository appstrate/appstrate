// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { forbidden, invalidRequest, notFound } from "../lib/errors.ts";

/**
 * Validate that an application belongs to the given org.
 * Returns `{ id, isDefault }` or null if not found.
 * Shared by the app-context middleware and SSE auth.
 */
export async function validateApplicationInOrg(
  appId: string,
  orgId: string,
): Promise<{ id: string; isDefault: boolean } | null> {
  const [app] = await db
    .select({ id: applications.id, isDefault: applications.isDefault })
    .from(applications)
    .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)))
    .limit(1);
  return app ?? null;
}

/**
 * Middleware: resolve application context for app-scoped routes.
 *
 * Resolution order:
 * 1. applicationId already pinned by an auth strategy (API key, OIDC JWT, …)
 * 2. X-App-Id header (session auth — dashboard users)
 *
 * If a strategy already pinned an application and the request also carries
 * an `X-App-Id` header, the header MUST match the pinned value. Otherwise
 * a holder of a Bearer token scoped to App A could spoof `X-App-Id: App B`
 * (same org) and reach a second application's data. Session callers never
 * pin an application, so their header is still honoured as the primary
 * signal.
 *
 * Validates that the application belongs to the current org.
 * Sets c.set("applicationId") on success.
 */
export function requireAppContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const pinned = c.get("applicationId");
    const headerApp = c.req.header("X-App-Id");

    if (pinned && headerApp && headerApp !== pinned) {
      throw forbidden("X-App-Id does not match authenticated application");
    }

    const appId = pinned ?? headerApp;

    if (!appId) {
      throw invalidRequest(
        "Application context required. Provide X-App-Id header or use an API key.",
        "X-App-Id",
      );
    }

    const orgId = c.get("orgId");
    const app = await validateApplicationInOrg(appId, orgId);

    if (!app) {
      throw notFound(`Application '${appId}' not found in this organization`);
    }

    c.set("applicationId", appId);
    return next();
  };
}
