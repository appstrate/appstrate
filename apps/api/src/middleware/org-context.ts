import type { Context, Next } from "hono";
import type { AppEnv, OrgRole } from "../types/index.ts";
import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { organizationMembers } from "@appstrate/db/schema";

/**
 * Middleware: extract X-Org-Id header, verify membership, inject orgId + orgRole.
 * Returns 400 if header is missing, 403 if user is not a member of the org.
 */
export function requireOrgContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const orgId = c.req.header("X-Org-Id");
    if (!orgId) {
      return c.json({ error: "MISSING_ORG_CONTEXT", message: "Header X-Org-Id est requis" }, 400);
    }

    const user = c.get("user");
    const rows = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, user.id)))
      .limit(1);

    if (!rows[0]) {
      return c.json(
        { error: "FORBIDDEN", message: "Vous n'etes pas membre de cette organisation" },
        403,
      );
    }

    c.set("orgId", orgId);
    c.set("orgRole", rows[0].role as OrgRole);
    return next();
  };
}
