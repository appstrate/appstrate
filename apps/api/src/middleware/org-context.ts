// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv, OrgRole } from "../types/index.ts";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers, organizations } from "@appstrate/db/schema";
import { invalidRequest, forbidden } from "../lib/errors.ts";
import { scopedWhere } from "../lib/db-helpers.ts";

/**
 * Middleware: extract X-Org-Id header, verify membership, inject orgId + orgRole + orgSlug.
 * Returns 400 if header is missing, 403 if user is not a member of the org.
 *
 * If an auth strategy already pinned an org (e.g. an OIDC dashboard token
 * scoped to a specific org), the X-Org-Id header MUST match the pinned
 * value. Otherwise a holder of a token scoped to org A — who is also a
 * member of org B by session — could spoof `X-Org-Id: B` and bypass the
 * token's consent scope. Symmetric with `requireAppContext`.
 */
export function requireOrgContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const headerOrg = c.req.header("X-Org-Id");
    const pinned = c.get("orgId");

    if (pinned && headerOrg && headerOrg !== pinned) {
      throw forbidden("X-Org-Id does not match authenticated organization");
    }

    const orgId = pinned ?? headerOrg;
    if (!orgId) {
      throw invalidRequest("X-Org-Id header is required", "X-Org-Id");
    }

    const user = c.get("user");
    const rows = await db
      .select({ role: organizationMembers.role, slug: organizations.slug })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(
        scopedWhere(organizationMembers, {
          orgId,
          extra: [eq(organizationMembers.userId, user.id)],
        }),
      )
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
