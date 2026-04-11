// SPDX-License-Identifier: Apache-2.0

/**
 * End-user OIDC auth strategy.
 *
 * Matches `Authorization: Bearer ey...` headers, verifies the JWT against
 * the module-owned JWKS endpoint (served by Better Auth `/api/auth/jwks`),
 * resolves the impersonated end-user from claims, and emits an
 * `AuthResolution` with `endUser` populated. Core's strict run-visibility
 * filter then scopes everything to the end-user automatically — no core
 * edit, no RBAC bypass.
 *
 * Fast no-match path (discipline rule from Phase 0 README): return `null`
 * immediately unless the header starts with `Bearer ey`. Any JWT is
 * candidate for verification, but anything shorter / non-JWT is not.
 *
 * Resolution flow:
 *   1. verifyEndUserAccessToken() — signature + issuer + expiry checks
 *   2. lookup `end_users` row by `endUserId` claim (+ verify profile active)
 *   3. lookup owning org via `applications.orgId`
 *   4. lookup Better Auth user row for name/email (fall back to claims)
 *   5. scopesToPermissions() — translate OAuth scopes to core RBAC strings
 *
 * If any step fails → return null (falls through to core Bearer / cookie).
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications, user as authUsers } from "@appstrate/db/schema";
import type { AuthStrategy, AuthResolution } from "@appstrate/core/module";
import { logger } from "../../../lib/logger.ts";
import { verifyEndUserAccessToken } from "../services/enduser-token.ts";
import { lookupEndUser } from "../services/enduser-mapping.ts";
import { scopesToPermissions } from "./claims.ts";

export const oidcAuthStrategy: AuthStrategy = {
  id: "oidc-enduser-jwt",

  async authenticate({ headers }): Promise<AuthResolution | null> {
    const authHeader = headers.get("authorization") ?? headers.get("Authorization");
    if (!authHeader) return null;
    // Fast no-match: anything other than a JWT-looking Bearer → skip.
    if (!authHeader.startsWith("Bearer ey")) return null;

    const token = authHeader.slice(7);
    const claims = await verifyEndUserAccessToken(token);
    if (!claims) return null;

    // Phase 1 requires the oauth-provider plugin to inject `endUserId` +
    // `applicationId` into access tokens via its custom-claims closure
    // (Stage 5). Tokens that lack them are treated as "not for this
    // strategy" and fall through to core auth.
    if (!claims.endUserId || !claims.applicationId) return null;

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

    // Core auth middleware requires a valid `user` + `orgId` + `orgRole` on
    // every authenticated request. We resolve the owning org through the
    // application FK and pull the Better Auth user row for name/email.
    const [app] = await db
      .select({ orgId: applications.orgId })
      .from(applications)
      .where(eq(applications.id, endUser.applicationId))
      .limit(1);
    if (!app) return null;

    const [authUserRow] = await db
      .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, claims.authUserId))
      .limit(1);

    const permissions = [...scopesToPermissions(claims.scope)];

    return {
      user: {
        id: claims.authUserId,
        email: authUserRow?.email ?? claims.email ?? "",
        name: authUserRow?.name ?? claims.name ?? "",
      },
      orgId: app.orgId,
      // End-users are NOT org members — they impersonate through an app.
      // orgRole is set to "member" to satisfy the contract; core's strict
      // end-user filter ignores role-based visibility entirely when
      // `endUser` is in context.
      orgRole: "member",
      authMethod: "oidc-enduser-jwt",
      applicationId: endUser.applicationId,
      permissions,
      endUser: {
        id: endUser.endUserId,
        applicationId: endUser.applicationId,
        email: endUser.email ?? undefined,
        name: endUser.name ?? undefined,
      },
    };
  },
};
