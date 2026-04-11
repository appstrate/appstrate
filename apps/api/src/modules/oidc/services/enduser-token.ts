// SPDX-License-Identifier: Apache-2.0

/**
 * End-user token verification service.
 *
 * Verifies ES256-signed JWT access tokens issued by the Better Auth
 * `oauth-provider` plugin. Uses `jose` for signature verification via the
 * module-owned JWKS endpoint (`/api/auth/jwks`, served automatically by the
 * Better Auth handler once the `jwt` plugin is registered).
 *
 * The JWKS fetch is lazy: at module init time the Better Auth singleton is
 * not yet built (`createAuth()` runs strictly after `init()`), so we cannot
 * probe the endpoint. Instead the remote JWKS client is constructed on
 * first verification and the URL resolved from `APP_URL` env at that moment.
 */

import * as jose from "jose";
import { getEnv } from "@appstrate/env";

export interface EndUserClaims {
  /** Better Auth `user.id` (the JWT `sub` claim). */
  authUserId: string;
  /** Application-scoped `end_users.id` (custom claim). */
  endUserId?: string;
  /** Application ID carried through from the OAuth client `referenceId`. */
  applicationId?: string;
  email?: string;
  name?: string;
  /** Space-separated scope string as issued by the oauth-provider plugin. */
  scope?: string;
}

let _jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
  if (!_jwks) {
    const env = getEnv();
    _jwks = jose.createRemoteJWKSet(new URL("/api/auth/jwks", env.APP_URL), {
      cacheMaxAge: 60 * 60 * 1000, // 1h
    });
  }
  return _jwks;
}

/**
 * Verify a Bearer access token and return its claims, or `null` if the token
 * is malformed, has an invalid signature, is expired, or fails issuer/audience
 * checks. Never throws — designed to be called from the auth middleware hot
 * path where the token is just as likely to be a random opaque string.
 */
export async function verifyEndUserAccessToken(token: string): Promise<EndUserClaims | null> {
  try {
    const env = getEnv();
    const { payload } = await jose.jwtVerify(token, getJwks(), {
      issuer: env.APP_URL,
      algorithms: ["ES256"],
    });
    if (!payload.sub) return null;
    const extra = payload as Record<string, unknown>;
    return {
      authUserId: payload.sub,
      endUserId: typeof extra.endUserId === "string" ? extra.endUserId : undefined,
      applicationId: typeof extra.applicationId === "string" ? extra.applicationId : undefined,
      email: typeof extra.email === "string" ? extra.email : undefined,
      name: typeof extra.name === "string" ? extra.name : undefined,
      scope: typeof extra.scope === "string" ? extra.scope : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Test hook — reset the cached JWKS client so each test run can rebind the
 * endpoint URL (e.g. after spinning up a new Better Auth instance).
 */
export function resetJwksCache(): void {
  _jwks = null;
}
