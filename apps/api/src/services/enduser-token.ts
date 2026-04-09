// SPDX-License-Identifier: Apache-2.0

/**
 * End-User Token Verification Service
 *
 * Verifies JWT access tokens issued by the oauth-provider plugin.
 * Uses jose (bundled with better-auth) for ES256 JWT verification via JWKS.
 */

import * as jose from "jose";
import { getEnv } from "@appstrate/env";
import { resolveEndUserPermissions, type EndUserRole } from "../lib/permissions.ts";

export interface EndUserClaims {
  /** Better Auth user ID (sub claim) */
  authUserId: string;
  /** Application-scoped end-user ID (custom claim) */
  endUserId?: string;
  /** Application ID / OAuth client ID (custom claim or aud) */
  applicationId?: string;
  /** End-user email */
  email?: string;
  /** End-user name */
  name?: string;
  /** Granted scopes */
  scope?: string;
  /** End-user role within the application */
  role?: string;
}

// Lazy-initialized JWKS client — fetches keys from our own JWKS endpoint
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function getJWKS(): ReturnType<typeof jose.createRemoteJWKSet> {
  if (!jwks) {
    const env = getEnv();
    const jwksUrl = new URL("/api/auth/jwks", env.APP_URL);
    jwks = jose.createRemoteJWKSet(jwksUrl, {
      cacheMaxAge: 60 * 60 * 1000, // Cache JWKS for 1 hour
    });
  }
  return jwks;
}

/**
 * Verify an end-user JWT access token issued by the oauth-provider plugin.
 *
 * Returns the decoded claims if valid, or null if verification fails.
 * This is designed to be called in the auth middleware — it should never throw.
 */
export async function verifyEndUserAccessToken(token: string): Promise<EndUserClaims | null> {
  try {
    const env = getEnv();
    const { payload } = await jose.jwtVerify(token, getJWKS(), {
      issuer: env.APP_URL,
    });

    if (!payload.sub) return null;

    return {
      authUserId: payload.sub,
      endUserId: (payload as Record<string, unknown>).endUserId as string | undefined,
      applicationId: (payload as Record<string, unknown>).applicationId as string | undefined,
      email: (payload as Record<string, unknown>).email as string | undefined,
      name: (payload as Record<string, unknown>).name as string | undefined,
      scope: (payload as Record<string, unknown>).scope as string | undefined,
      role: (payload as Record<string, unknown>).role as string | undefined,
    };
  } catch {
    // Invalid token — fall through to cookie auth
    return null;
  }
}

/**
 * Map OIDC scopes to Appstrate permission set.
 */
export function scopesToPermissions(scope?: string): Set<string> {
  const permissions = new Set<string>();
  if (!scope) return permissions;

  const scopes = scope.split(" ");

  for (const s of scopes) {
    switch (s) {
      case "connections":
        permissions.add("connections:read");
        break;
      case "connections:write":
        permissions.add("connections:read");
        permissions.add("connections:write");
        break;
      case "runs":
        permissions.add("runs:read");
        break;
      case "runs:write":
        permissions.add("runs:read");
        permissions.add("runs:write");
        break;
      // openid, profile, email don't map to resource permissions
    }
  }

  return permissions;
}

// ---------------------------------------------------------------------------
// Role-based permission resolution
// ---------------------------------------------------------------------------

const VALID_END_USER_ROLES = new Set<string>(["admin", "member", "viewer"]);

/**
 * Resolve end-user permissions from JWT claims.
 *
 * Strategy:
 * 1. If `role` claim present and valid → role-based permissions
 * 2. If resource scopes present → intersect with role permissions (scope = ceiling)
 * 3. If no role (legacy token) → fall back to scope-based permissions
 *
 * For first-party apps (scopes = "openid profile email" only), identity scopes
 * produce an empty scope set → full role permissions are used.
 */
export function resolveEndUserPermissionsFromClaims(claims: EndUserClaims): Set<string> {
  const role = claims.role;

  // Legacy tokens without role → fall back to scope-based
  if (!role || !VALID_END_USER_ROLES.has(role)) {
    return scopesToPermissions(claims.scope);
  }

  const rolePerms = resolveEndUserPermissions(role as EndUserRole);

  // If resource scopes present, intersect (scope = ceiling for third-party apps)
  const scopePerms = scopesToPermissions(claims.scope);
  if (scopePerms.size > 0) {
    const intersection = new Set<string>();
    for (const perm of rolePerms) {
      if (scopePerms.has(perm)) intersection.add(perm);
    }
    return intersection;
  }

  // No resource scopes (identity-only or none) → full role permissions
  return rolePerms;
}

/**
 * Reset JWKS cache — for testing only.
 */
export function resetJWKSCache(): void {
  jwks = null;
}
