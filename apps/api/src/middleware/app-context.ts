// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { forbidden, invalidRequest, notFound } from "../lib/errors.ts";

/**
 * Resolved application row exposed on the Hono context under `c.get("app")`.
 * Carries the fields every app-scoped route currently needs — keep the set
 * tight so downstream services can destructure without re-reading the row.
 */
export interface AppContextRow {
  id: string;
  orgId: string;
  isDefault: boolean;
}

/**
 * Validate that an application belongs to the given org.
 * Returns the full `AppContextRow` or null if not found.
 * Shared by the app-context middleware and SSE auth.
 */
export async function validateApplicationInOrg(
  applicationId: string,
  orgId: string,
): Promise<AppContextRow | null> {
  const [app] = await db
    .select({
      id: applications.id,
      orgId: applications.orgId,
      isDefault: applications.isDefault,
    })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  return app ?? null;
}

/**
 * Middleware: resolve application context for app-scoped routes.
 *
 * Resolution order:
 * 1. applicationId already pinned by an auth strategy (API key, OIDC JWT, …)
 * 2. X-Application-Id header (session auth — dashboard users)
 *
 * If a strategy already pinned an application and the request also carries
 * an `X-Application-Id` header, the header MUST match the pinned value. Otherwise
 * a holder of a Bearer token scoped to App A could spoof `X-Application-Id: App B`
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
    const headerApp = c.req.header("X-Application-Id");

    if (pinned && headerApp && headerApp !== pinned) {
      throw forbidden("X-Application-Id does not match authenticated application");
    }

    const applicationId = pinned ?? headerApp;

    if (!applicationId) {
      throw invalidRequest(
        "Application context required. Provide X-Application-Id header or use an API key.",
        "X-Application-Id",
      );
    }

    const orgId = c.get("orgId");
    const app = await validateApplicationInOrg(applicationId, orgId);

    if (!app) {
      throw notFound(`Application '${applicationId}' not found in this organization`);
    }

    c.set("applicationId", applicationId);
    c.set("app", app);
    return next();
  };
}
