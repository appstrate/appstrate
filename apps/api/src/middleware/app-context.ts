// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import { isInternalDispatch } from "../lib/internal-dispatch.ts";

/**
 * Core route prefixes that require an application context (`X-Application-Id`,
 * or the API key's own `applicationId`).
 *
 * Core-only by design: modules own app-scoping for their own routes (the
 * webhooks module, for instance, gates on an explicit `applicationId` body /
 * query field), so a module never adds a row here.
 *
 * This list is read by the app-context middleware wiring in BOTH
 * `apps/api/src/index.ts` and the test harness `apps/api/test/helpers/app.ts`.
 * It lived as two hand-kept copies until they were reconciled here — a route
 * family added to one and not the other gives a test app whose app-scoping
 * differs from production, which is exactly the kind of gap tests exist to
 * close.
 *
 * Deliberately NOT exported: `isAppScopedPath` below is the only reader, and
 * it is what both call sites import. Handing out the array would let a caller
 * re-derive the predicate (`.some(startsWith)`) its own way, which is the
 * shape the drift took the first time.
 */
const APP_SCOPED_PREFIXES = [
  "/api/agents",
  "/api/runs",
  "/api/schedules",
  "/api/end-users",
  "/api/api-keys",
  "/api/notifications",
  "/api/packages",
  "/api/integrations",
  "/api/uploads",
  "/api/files",
] as const;

/** True when `path` belongs to a core app-scoped route family. */
export function isAppScopedPath(path: string): boolean {
  return APP_SCOPED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

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
 * The org's default application (`is_default = true`). Used as the last-resort
 * fallback for header-less MCP callers — see `requireAppContext` and the MCP
 * router's per-session app-scope resolution.
 */
export async function defaultAppForOrg(orgId: string): Promise<AppContextRow | null> {
  const [app] = await db
    .select({
      id: applications.id,
      orgId: applications.orgId,
      isDefault: applications.isDefault,
    })
    .from(applications)
    .where(and(eq(applications.orgId, orgId), eq(applications.isDefault, true)))
    .limit(1);
  return app ?? null;
}

/**
 * Middleware: resolve application context for app-scoped routes.
 *
 * Resolution order (transport-agnostic, symmetric with `requireOrgContext`):
 * 1. applicationId already pinned by an auth strategy (API key, OIDC JWT, …)
 * 2. X-Application-Id header (session auth — dashboard users)
 * 3. the org's default application
 *
 * If a strategy already pinned an application and the request also carries
 * an `X-Application-Id` header, the header MUST match the pinned value. Otherwise
 * a holder of a Bearer token scoped to App A could spoof `X-Application-Id: App B`
 * (same org) and reach a second application's data. Session callers never
 * pin an application, so their header is still honoured as the primary
 * signal.
 *
 * The default-app fallback exists SOLELY for the in-process MCP sub-dispatch: a
 * per-org MCP Bearer token pins the org but reaches an app-scoped route via an
 * in-process re-entry carrying NO `X-Application-Id`, so it resolves to the
 * org's default application. That re-entry is identified by the trusted
 * internal-dispatch marker (an unguessable per-process secret, stripped from
 * any client-supplied copy), so the fallback is gated on it. A direct caller —
 * session/SPA or CLI — that omits `X-Application-Id` still gets a 400, NOT a
 * silent fallback to the default app (which would weaken app isolation and is
 * exactly the contract `org-isolation` asserts).
 * Validates that the application belongs to the current org. Sets
 * c.set("applicationId") + c.set("app") on success.
 */
export function requireAppContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const pinned = c.get("applicationId");
    const headerApp = c.req.header("X-Application-Id");

    if (pinned && headerApp && headerApp !== pinned) {
      throw forbidden("X-Application-Id does not match authenticated application");
    }

    const orgId = c.get("orgId");
    const explicitApp = pinned ?? headerApp;

    if (explicitApp) {
      const app = await validateApplicationInOrg(explicitApp, orgId);
      if (!app) {
        throw notFound(`Application '${explicitApp}' not found in this organization`);
      }
      c.set("applicationId", explicitApp);
      c.set("app", app);
      return next();
    }

    // Header-less caller. The org's default-application fallback is reserved
    // for the trusted in-process MCP re-entry (marker present); every other
    // header-less caller must supply an explicit application.
    if (isInternalDispatch(c.req.raw.headers)) {
      const active = await defaultAppForOrg(orgId);
      if (active) {
        c.set("applicationId", active.id);
        c.set("app", active);
        return next();
      }
    }

    throw invalidRequest(
      "Application context required. Provide X-Application-Id header or use an API key.",
      "X-Application-Id",
    );
  };
}
