// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Test Hono app for EE billing route tests.
 *
 * Simulates the platform's auth and org-context middleware by reading
 * test headers (X-Test-Org-Id, X-Test-Org-Role) instead of requiring
 * real Better Auth sessions.
 */
import { Hono } from "hono";
import eeModule from "../../src/index.ts";
import { createBillingRoutes } from "../../src/routes/billing.ts";
import type { OrgRole } from "@appstrate/core/permissions";

/**
 * The permissions the platform's RBAC aggregation grants `orgRole` from this module's own
 * contribution — read from the module, never restated, so this harness matches production.
 */
export function permissionsForRole(orgRole: OrgRole): ReadonlySet<string> {
  const granted = new Set<string>();
  for (const entry of eeModule.permissionsContribution?.() ?? []) {
    if (entry.level !== "org" || !entry.grantTo.includes(orgRole)) continue;
    for (const action of entry.actions) granted.add(`${entry.resource}:${action}`);
  }
  return granted;
}

type EeTestEnv = {
  Variables: {
    orgId: string;
    orgRole: OrgRole;
    user: { id: string; email: string; name: string };
    permissions: ReadonlySet<string>;
  };
};

let cachedApp: Hono<EeTestEnv> | null = null;

export function getTestApp(): Hono<EeTestEnv> {
  if (cachedApp) return cachedApp;

  const app = new Hono<EeTestEnv>();

  // Simulate platform middleware: extract org context from test headers.
  // Skip auth for public paths (webhooks are verified by Stripe signature, not session).
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/billing/webhooks") return next();
    const orgId = c.req.header("X-Test-Org-Id");
    const orgRole = (c.req.header("X-Test-Org-Role") ?? "owner") as OrgRole;
    if (!orgId) return c.json({ error: "Missing X-Test-Org-Id" }, 401);
    c.set("orgId", orgId);
    c.set("orgRole", orgRole);
    // Exactly what `apps/api/src/lib/auth-pipeline.ts` writes — the platform
    // sets `user`, never a bare `userId`. Any other shape here lets a route
    // read a variable production never populates.
    const userId = c.req.header("X-Test-User-Id") ?? "user-test";
    c.set("user", { id: userId, email: `${userId}@test.local`, name: userId });
    const permissions = new Set<string>(permissionsForRole(orgRole));
    // The platform unions each module's `principalPermissions` answer into the
    // same set — the header stands in for EE's billing-manager resolver, so
    // a non-admin manager reaches the routes exactly as they would in production.
    for (const p of (c.req.header("X-Test-Principal-Grants") ?? "").split(",")) {
      if (p.trim()) permissions.add(p.trim());
    }
    c.set("permissions", permissions);
    await next();
  });

  // Billing router declares full `/api/billing/...` paths (matches the
  // module-contract convention — modules mount at `/` and own their own
  // prefixes), so we mount it at the origin root, NOT under `/api`.
  // Mounting under `/api` would resolve every path to `/api/api/billing/*`
  // and 404 every test.
  app.route("/", createBillingRoutes("http://localhost:3000"));

  cachedApp = app;
  return app;
}
