// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC auth strategy — polymorphic dispatch on `actor_type`.
 *
 * Matches `Authorization: Bearer ey...` headers and verifies the JWT against
 * the module-owned JWKS endpoint. The token's `actor_type` claim selects one
 * of two resolution paths:
 *
 * - **`user`**: instance-level token. Load the Better Auth user row and
 *   return a partial `AuthResolution` (no org, no role). The auth pipeline
 *   defers org resolution to the `X-Org-Id` middleware (same as session
 *   auth). `authMethod: "oauth2-instance"`.
 *
 * - **`dashboard_user`**: load the Better Auth user row, re-verify that the
 *   user is still a member of the token's `org_id`, and emit the current
 *   `org_role` from the DB (not the stale claim — prevents role escalation
 *   after a demotion). Core routes see a normal dashboard user with
 *   `authMethod: "oauth2-dashboard"`.
 *
 * - **`end_user`**: load the `end_users` row, verify profile is active,
 *   and emit with `endUser` populated. Core's strict end-user filter kicks
 *   in automatically.
 *
 * Fast no-match path: return `null` immediately unless the header starts
 * with `Bearer ey`. Any JWT is candidate for verification, but anything
 * shorter / non-JWT is not.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as authUsers, organizationMembers } from "@appstrate/db/schema";
import type { AuthStrategy, AuthResolution } from "@appstrate/core/module";
import type { OrgRole } from "../../../types/index.ts";
import { logger } from "../../../lib/logger.ts";
import { verifyEndUserAccessToken, type AccessTokenClaims } from "../services/enduser-token.ts";
import { lookupEndUser } from "../services/enduser-mapping.ts";
import { getClient } from "../services/oauth-admin.ts";
import { scopesToPermissions } from "./claims.ts";

export const oidcAuthStrategy: AuthStrategy = {
  id: "oidc-jwt",

  async authenticate({ headers }): Promise<AuthResolution | null> {
    const authHeader = headers.get("authorization") ?? headers.get("Authorization");
    if (!authHeader) return null;
    if (!authHeader.startsWith("Bearer ey")) return null;

    const token = authHeader.slice(7);
    const claims = await verifyEndUserAccessToken(token);
    if (!claims) return null;

    // Defense-in-depth: reject tokens from disabled clients. The `azp`
    // claim carries the OAuth client_id — load the client and verify it
    // is still active. This adds one DB lookup per request; a short-TTL
    // cache could optimize this later if it becomes a hot path.
    if (claims.clientId) {
      const client = await getClient(claims.clientId);
      if (!client) {
        logger.info("OIDC strategy: token references unknown client — rejecting", {
          module: "oidc",
          clientId: claims.clientId,
        });
        return null;
      }
      if (client.disabled) {
        logger.info("OIDC strategy: token's client is disabled — rejecting", {
          module: "oidc",
          clientId: claims.clientId,
        });
        return null;
      }
      // Cross-validate actor_type vs client level to prevent confused deputy.
      const actorToLevel: Record<string, string> = {
        user: "instance",
        dashboard_user: "org",
        end_user: "application",
      };
      const expectedLevel = claims.actorType ? actorToLevel[claims.actorType] : undefined;
      if (expectedLevel && client.level !== expectedLevel) {
        logger.warn("OIDC strategy: actor_type / client level mismatch — rejecting", {
          module: "oidc",
          actorType: claims.actorType,
          clientLevel: client.level,
        });
        return null;
      }
    }

    if (claims.actorType === "user") {
      return resolveInstanceUser(claims);
    }
    if (claims.actorType === "dashboard_user") {
      return resolveDashboardUser(claims);
    }
    if (claims.actorType === "end_user") {
      return resolveEndUser(claims);
    }
    // No actor_type claim — legacy or malformed token. Fall through so core
    // Bearer / cookie auth gets a chance to handle it.
    return null;
  },
};

async function resolveInstanceUser(claims: AccessTokenClaims): Promise<AuthResolution | null> {
  const [authUserRow] = await db
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, claims.authUserId))
    .limit(1);
  if (!authUserRow) {
    logger.debug("OIDC strategy: instance user row not found", {
      module: "oidc",
      userId: claims.authUserId,
    });
    return null;
  }
  // Instance tokens carry no org context. Return a partial resolution —
  // orgId and orgRole are left undefined. The auth pipeline defers org
  // resolution to the X-Org-Id middleware (same path as session auth).
  // Permissions are also deferred — the pipeline derives them from orgRole
  // after org-context resolves, via resolvePermissions(orgRole).
  return {
    user: {
      id: authUserRow.id,
      email: authUserRow.email,
      name: authUserRow.name ?? "",
    },
    authMethod: "oauth2-instance",
    permissions: [],
  };
}

async function resolveDashboardUser(claims: AccessTokenClaims): Promise<AuthResolution | null> {
  if (!claims.orgId) {
    logger.debug("OIDC strategy: dashboard token missing org_id claim", { module: "oidc" });
    return null;
  }
  const [authUserRow] = await db
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, claims.authUserId))
    .limit(1);
  if (!authUserRow) {
    logger.debug("OIDC strategy: dashboard user row not found", {
      module: "oidc",
      userId: claims.authUserId,
    });
    return null;
  }
  // Re-verify membership + read the current role from the DB. Tokens
  // carry `org_role` for audit/telemetry, but the DB role wins every time
  // — if the user was demoted or removed between token mint and use, we
  // enforce the current state immediately.
  const [membership] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, claims.authUserId),
        eq(organizationMembers.orgId, claims.orgId),
      ),
    )
    .limit(1);
  if (!membership) {
    logger.info("OIDC strategy: dashboard user no longer a member of org — rejecting token", {
      module: "oidc",
      userId: claims.authUserId,
      orgId: claims.orgId,
    });
    return null;
  }
  const role = membership.role as OrgRole;
  const permissions = [...scopesToPermissions(claims.scope, "dashboard_user", role)];
  return {
    user: {
      id: authUserRow.id,
      email: authUserRow.email,
      name: authUserRow.name ?? "",
    },
    orgId: claims.orgId,
    orgRole: role,
    authMethod: "oauth2-dashboard",
    permissions,
  };
}

async function resolveEndUser(claims: AccessTokenClaims): Promise<AuthResolution | null> {
  if (!claims.endUserId || !claims.applicationId) {
    logger.debug("OIDC strategy: end_user token missing required claims", { module: "oidc" });
    return null;
  }
  const endUser = await lookupEndUser(claims.endUserId);
  if (!endUser) {
    logger.debug("OIDC strategy: end-user not found", {
      module: "oidc",
      endUserId: claims.endUserId,
    });
    return null;
  }
  if (endUser.applicationId !== claims.applicationId) {
    logger.warn("OIDC strategy: claim applicationId mismatch", {
      module: "oidc",
      endUserId: claims.endUserId,
      claimApp: claims.applicationId,
      realApp: endUser.applicationId,
    });
    return null;
  }
  if (endUser.status !== "active") {
    logger.info("OIDC strategy: end-user not active", {
      module: "oidc",
      endUserId: endUser.endUserId,
      status: endUser.status,
    });
    return null;
  }

  const [authUserRow] = await db
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, claims.authUserId))
    .limit(1);

  const permissions = [...scopesToPermissions(claims.scope, "end_user")];

  return {
    user: {
      id: claims.authUserId,
      email: authUserRow?.email ?? claims.email ?? "",
      name: authUserRow?.name ?? claims.name ?? "",
    },
    orgId: endUser.orgId,
    // End-users are NOT org members — core's strict end-user filter
    // ignores role-based visibility entirely when `endUser` is in context.
    orgRole: "member",
    authMethod: "oauth2-end-user",
    applicationId: endUser.applicationId,
    permissions,
    endUser: {
      id: endUser.endUserId,
      applicationId: endUser.applicationId,
      email: endUser.email ?? undefined,
      name: endUser.name ?? undefined,
    },
  };
}
