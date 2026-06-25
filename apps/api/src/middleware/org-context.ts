// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { OrgSettings } from "@appstrate/shared-types";
import type { AppEnv, OrgRole } from "../types/index.ts";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers, organizations } from "@appstrate/db/schema";
import { invalidRequest, forbidden } from "../lib/errors.ts";
import { scopedWhere } from "../lib/db-helpers.ts";

/**
 * Middleware: resolve the organization for the request, verify membership, and
 * inject orgId + orgRole + orgSlug.
 *
 * Precedence: a strategy-pinned org, then the `X-Org-Id` header. If an auth
 * strategy already pinned an org (e.g. a per-org MCP Bearer token or an OIDC
 * dashboard token scoped to a specific org), the `X-Org-Id` header MUST match
 * the pinned value — otherwise a holder of a token scoped to org A who is also
 * a member of org B by session could spoof `X-Org-Id: B` and bypass the token's
 * consent scope. Symmetric with `requireAppContext`.
 *
 * A caller that neither pins an org nor sends the header gets a 400. A token
 * that pins an org reaches this middleware with `pinned` set, so it is only
 * membership-checked here.
 */
export function requireOrgContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const headerOrg = c.req.header("X-Org-Id");
    const pinned = c.get("orgId");

    if (pinned && headerOrg && headerOrg !== pinned) {
      throw forbidden("X-Org-Id does not match authenticated organization");
    }

    const user = c.get("user");
    const orgId = pinned ?? headerOrg;

    if (!orgId) {
      throw invalidRequest("X-Org-Id header is required", "X-Org-Id");
    }

    const rows = await db
      .select({
        role: organizationMembers.role,
        slug: organizations.slug,
        name: organizations.name,
        // Piggyback the settings JSONB on the membership join so downstream
        // per-request consumers (API-version middleware) don't issue a
        // second organizations query on every authenticated request.
        orgSettings: organizations.orgSettings,
      })
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
    c.set("orgName", rows[0].name);
    c.set("orgSettings", (rows[0].orgSettings ?? {}) as OrgSettings);
    return next();
  };
}
