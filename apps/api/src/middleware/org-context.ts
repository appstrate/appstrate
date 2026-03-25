import type { Context, Next } from "hono";
import type { AppEnv, OrgRole } from "../types/index.ts";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers, organizations } from "@appstrate/db/schema";
import { invalidRequest, forbidden } from "../lib/errors.ts";

/**
 * Middleware: extract X-Org-Id header, verify membership, inject orgId + orgRole + orgSlug.
 * Returns 400 if header is missing, 403 if user is not a member of the org.
 */
export function requireOrgContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const orgId = c.req.header("X-Org-Id");
    if (!orgId) {
      throw invalidRequest("X-Org-Id header is required", "X-Org-Id");
    }

    const user = c.get("user");
    const rows = await db
      .select({ role: organizationMembers.role, slug: organizations.slug })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, user.id)))
      .limit(1);

    if (!rows[0]) {
      throw forbidden("You are not a member of this organization");
    }

    c.set("orgId", orgId);
    c.set("orgRole", rows[0].role as OrgRole);
    c.set("orgSlug", rows[0].slug);
    return next();
  };
}
