// SPDX-License-Identifier: Apache-2.0

/**
 * End-user token verification service.
 *
 * Verifies ES256-signed JWT access tokens issued by the Better Auth
 * `oauth-provider` plugin. Fetches the JWKS directly from the Better Auth
 * singleton via `auth.api.getJwks()` (in-process) instead of doing an HTTP
 * round-trip to `${APP_URL}/api/auth/jwks`. This keeps the hot path fast,
 * removes any dependency on the platform being reachable over HTTP at
 * verify time (tests, Hono's `app.request()`, air-gapped deployments),
 * and guarantees the keys we verify against are exactly the keys the
 * local plugin just minted with — no staleness window.
 *
 * If the in-process fetch fails (e.g. `getAuth()` throws because the
 * singleton has not yet been built), we fall back to `jose.createRemoteJWKSet`
 * over HTTP so pre-boot code paths and external callers still work.
 */

import * as jose from "jose";
import { getEnv } from "@appstrate/env";
import { getAuth } from "@appstrate/db/auth";

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

type JwksResolver = (
  protectedHeader?: jose.JWSHeaderParameters,
  token?: jose.FlattenedJWSInput,
) => Promise<jose.CryptoKey>;

let _jwks: JwksResolver | null = null;

/**
 * Build an in-process JWKS resolver by fetching keys from the Better Auth
 * singleton's `jwt` plugin endpoint. Returns `null` if the singleton is not
 * yet initialized or the endpoint is unavailable — callers fall back to the
 * remote URL resolver.
 */
async function buildLocalJwks(): Promise<JwksResolver | null> {
  let auth: ReturnType<typeof getAuth>;
  try {
    auth = getAuth();
  } catch {
    return null;
  }
  const api = (auth as unknown as { api: Record<string, unknown> }).api;
  const getJwksFn = api?.getJwks;
  if (typeof getJwksFn !== "function") return null;
  try {
    const result = (await (getJwksFn as (args: { headers: Headers }) => Promise<unknown>)({
      headers: new Headers(),
    })) as { keys?: jose.JWK[] } | null;
    const keys = result?.keys;
    if (!Array.isArray(keys) || keys.length === 0) return null;
    return jose.createLocalJWKSet({ keys }) as unknown as JwksResolver;
  } catch {
    return null;
  }
}

function remoteJwks(): JwksResolver {
  const env = getEnv();
  return jose.createRemoteJWKSet(new URL("/api/auth/jwks", env.APP_URL), {
    cacheMaxAge: 60 * 60 * 1000, // 1h
  }) as unknown as JwksResolver;
}

async function getJwks(): Promise<JwksResolver> {
  if (_jwks) return _jwks;
  const local = await buildLocalJwks();
  _jwks = local ?? remoteJwks();
  return _jwks;
}

/**
 * Test hook — install a pre-built JWKS resolver, bypassing both the
 * in-process Better Auth lookup and the remote URL fallback. Tests that
 * spin up a local JWKS server and need verification to go through HTTP
 * (or that want to inject a specific public key) call this with their
 * own `jose.createLocalJWKSet(...)` or `jose.createRemoteJWKSet(...)`.
 *
 * Exported so test harness files can opt-out of the production resolver
 * chain without touching internal module state.
 */
export function _setJwksResolverForTesting(resolver: JwksResolver | null): void {
  _jwks = resolver;
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
    // Better Auth's oauth-provider plugin mints tokens with `iss` set to
    // `${baseURL}${basePath}` — in this codebase that is `${APP_URL}/api/auth`
    // (see `packages/db/src/auth.ts` basePath). Verifying against `APP_URL`
    // alone rejects every real token.
    const jwks = await getJwks();
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: `${env.APP_URL}/api/auth`,
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
