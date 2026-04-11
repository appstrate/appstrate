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

export type JwksResolver = (
  protectedHeader?: jose.JWSHeaderParameters,
  token?: jose.FlattenedJWSInput,
) => Promise<jose.CryptoKey>;

let _jwks: JwksResolver | null = null;

/**
 * Build an in-process JWKS resolver by fetching keys from the Better Auth
 * singleton's `jwt` plugin endpoint.
 */
async function buildLocalJwks(): Promise<JwksResolver> {
  const auth = getAuth();
  const api = (auth as unknown as { api: Record<string, unknown> }).api;
  const getJwksFn = api?.getJwks;
  if (typeof getJwksFn !== "function") {
    throw new Error("oidc: auth.api.getJwks is not available");
  }
  const result = (await (getJwksFn as (args: { headers: Headers }) => Promise<unknown>)({
    headers: new Headers(),
  })) as { keys?: jose.JWK[] } | null;
  const keys = result?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("oidc: jwks endpoint returned no keys");
  }
  return jose.createLocalJWKSet({ keys }) as unknown as JwksResolver;
}

async function getJwks(): Promise<JwksResolver> {
  if (_jwks) return _jwks;
  _jwks = await buildLocalJwks();
  return _jwks;
}

/**
 * Verify a Bearer access token and return its claims, or `null` if the token
 * is malformed, has an invalid signature, is expired, or fails issuer/audience
 * checks. Never throws — designed to be called from the auth middleware hot
 * path where the token is just as likely to be a random opaque string.
 *
 * Pass `deps.jwks` to inject a pre-built resolver (unit tests that pin a
 * specific keypair without rebuilding the Better Auth singleton). Production
 * callers pass nothing and get the cached in-process / remote resolver.
 */
export async function verifyEndUserAccessToken(
  token: string,
  deps?: { jwks?: JwksResolver },
): Promise<EndUserClaims | null> {
  try {
    const env = getEnv();
    // Better Auth's oauth-provider plugin mints tokens with `iss` set to
    // `${baseURL}${basePath}` — in this codebase that is `${APP_URL}/api/auth`
    // (see `packages/db/src/auth.ts` basePath). Verifying against `APP_URL`
    // alone rejects every real token.
    const jwks = deps?.jwks ?? (await getJwks());
    // Audience validation matches `validAudiences` in `auth/plugins.ts` —
    // RFC 8707 enforcement already happens at the token endpoint via
    // `oidcGuardsPlugin`, but the local verifier adds defense-in-depth so
    // a future plugin update that mints tokens with an unexpected `aud`
    // cannot slip through unchecked.
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: `${env.APP_URL}/api/auth`,
      audience: [env.APP_URL, `${env.APP_URL}/api/auth`],
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
 * Test harness override — install a pre-built JWKS resolver, or pass `null`
 * to clear the cache. Integration tests that rebuild the Better Auth
 * singleton between runs call this with `null` so the next verify
 * re-fetches the fresh ES256 keys. Tests that need to bypass the real
 * singleton entirely (e.g. a module-loaded preload with a different
 * keypair than the test's own mint key) call this with their own
 * `jose.createLocalJWKSet(...)`. Not intended for production callers —
 * use the `deps.jwks` param on `verifyEndUserAccessToken` for DI.
 */
export function overrideJwksResolver(resolver: JwksResolver | null): void {
  _jwks = resolver;
}
