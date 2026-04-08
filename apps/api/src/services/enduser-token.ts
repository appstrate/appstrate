// SPDX-License-Identifier: Apache-2.0

/**
 * End-User Token Verification Service
 *
 * Verifies JWT access tokens issued by the oauth-provider plugin.
 * Uses jose (bundled with better-auth) for ES256 JWT verification via JWKS.
 */

import * as jose from "jose";
import { getEnv } from "@appstrate/env";

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

/**
 * Reset JWKS cache — for testing only.
 */
export function resetJWKSCache(): void {
  jwks = null;
}
