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
 * ## Rotation safety
 *
 * The Better Auth `jwt` plugin rotates ES256 keys every 90 days with a
 * 7-day grace window. If we cached the JWKS indefinitely, rotation would
 * silently break verification until the process restarts. Two mechanisms
 * guard against that:
 *
 * 1. **TTL-based refresh** — the cached keyset expires after
 *    `JWKS_CACHE_TTL_MS` (5 minutes). The next verify after expiry
 *    re-fetches in-process, picking up any newly published key.
 * 2. **Unknown-kid refetch** — if `jose.jwtVerify` throws
 *    `JWKSNoMatchingKey` (the token header carries a `kid` we don't know
 *    about — i.e. a key rotated in since our last fetch), we refresh the
 *    cache eagerly once and retry. Repeated unknown-kid failures still
 *    fail closed so a bogus token doesn't trigger a DOS refetch loop.
 */

import * as jose from "jose";
import { getEnv } from "@appstrate/env";
import { logger } from "../../../lib/logger.ts";
import { getOidcAuthApi } from "../auth/api.ts";

/**
 * Polymorphic access-token claim shape. Every OIDC-minted token carries
 * `actor_type` as the discriminant. Dashboard-user tokens additionally
 * carry `org_id` + `org_role`; end-user tokens additionally carry
 * `application_id` + `end_user_id`. `sub` is always present (Better Auth
 * `user.id`).
 */
export interface AccessTokenClaims {
  /** Better Auth `user.id` (the JWT `sub` claim). */
  authUserId: string;
  /** Discriminant — see polymorphic fields below. */
  actorType?: "dashboard_user" | "end_user";
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** Space-separated scope string as issued by the oauth-provider plugin. */
  scope?: string;
  /** Org scope for dashboard users and (derived) for end-users. */
  orgId?: string;
  /** Dashboard flow: `owner` / `admin` / `member` / `viewer`. */
  orgRole?: "owner" | "admin" | "member" | "viewer";
  /** End-user flow: owning application id. */
  applicationId?: string;
  /** End-user flow: `eu_…` id of the impersonated end-user. */
  endUserId?: string;
}

/** @deprecated Kept as an alias for backward-compat with older callers. */
export type EndUserClaims = AccessTokenClaims;

export type JwksResolver = (
  protectedHeader?: jose.JWSHeaderParameters,
  token?: jose.FlattenedJWSInput,
) => Promise<jose.CryptoKey>;

interface JwksCacheEntry {
  resolver: JwksResolver;
  /** Epoch ms at which this resolver must be refetched. */
  expiresAt: number;
}

/** 5 minutes — short enough to propagate rotations quickly, long enough that
 *  steady-state verification never touches Better Auth. */
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

let _cache: JwksCacheEntry | null = null;
let _pendingRefresh: Promise<JwksResolver> | null = null;

/**
 * Build an in-process JWKS resolver by fetching keys from the Better Auth
 * singleton's `jwt` plugin endpoint.
 */
async function buildLocalJwks(): Promise<JwksResolver> {
  const api = getOidcAuthApi();
  const result = await api.getJwks({ headers: new Headers() });
  const keys = result?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("oidc: jwks endpoint returned no keys");
  }
  return jose.createLocalJWKSet({ keys }) as unknown as JwksResolver;
}

/**
 * Returns the cached JWKS resolver, refetching if the TTL has elapsed.
 * Concurrent callers share a single in-flight refetch so the Better Auth
 * API is not hammered under load.
 */
async function getJwks(options?: { forceRefresh?: boolean }): Promise<JwksResolver> {
  const now = Date.now();
  const fresh = _cache && _cache.expiresAt > now;
  if (!options?.forceRefresh && fresh) return _cache!.resolver;

  if (_pendingRefresh) return _pendingRefresh;

  _pendingRefresh = (async () => {
    try {
      const resolver = await buildLocalJwks();
      _cache = { resolver, expiresAt: Date.now() + JWKS_CACHE_TTL_MS };
      return resolver;
    } finally {
      _pendingRefresh = null;
    }
  })();
  return _pendingRefresh;
}

/**
 * Narrow detection for `jose`'s `JWKSNoMatchingKey` error — the signal that
 * the token header carries a `kid` our cached keyset does not know. We
 * cannot `instanceof JWKSNoMatchingKey` because jose's error classes are
 * stable via `.code` only.
 */
function isUnknownKidError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY"
  );
}

/**
 * Verify a Bearer access token and return its claims, or `null` if the token
 * is malformed, has an invalid signature, is expired, or fails issuer/audience
 * checks. Never throws — designed to be called from the auth middleware hot
 * path where the token is just as likely to be a random opaque string.
 *
 * Pass `deps.jwks` to inject a pre-built resolver (unit tests that pin a
 * specific keypair without rebuilding the Better Auth singleton). Production
 * callers pass nothing and get the TTL-cached in-process resolver, with an
 * automatic one-shot refresh if jose reports an unknown `kid`.
 */
export async function verifyEndUserAccessToken(
  token: string,
  deps?: { jwks?: JwksResolver },
): Promise<AccessTokenClaims | null> {
  const env = getEnv();
  // Better Auth's oauth-provider plugin mints tokens with `iss` set to
  // `${baseURL}${basePath}` — in this codebase that is `${APP_URL}/api/auth`
  // (see `packages/db/src/auth.ts` basePath). Verifying against `APP_URL`
  // alone rejects every real token.
  const issuer = `${env.APP_URL}/api/auth`;
  // Audience validation matches `validAudiences` in `auth/plugins.ts` —
  // RFC 8707 enforcement already happens at the token endpoint via
  // `oidcGuardsPlugin`, but the local verifier adds defense-in-depth so
  // a future plugin update that mints tokens with an unexpected `aud`
  // cannot slip through unchecked.
  const audience = [env.APP_URL, `${env.APP_URL}/api/auth`];

  const tryVerify = async (jwks: JwksResolver) =>
    jose.jwtVerify(token, jwks, { issuer, audience, algorithms: ["ES256"] });

  let payload: jose.JWTPayload;
  try {
    const jwks = deps?.jwks ?? (await getJwks());
    ({ payload } = await tryVerify(jwks));
  } catch (err) {
    // Unknown-kid path: refresh the keyset once and retry. Handles the
    // 7-day rotation grace window — after rotation, clients continue to
    // present tokens signed by the old key for a few minutes until the
    // new kid propagates through our TTL, so a single refetch restores
    // steady-state verification without waiting on the TTL expiry.
    //
    // Skipped when the caller injected their own `deps.jwks` (tests) —
    // they own their key lifecycle and a refetch would defeat the DI.
    if (!deps?.jwks && isUnknownKidError(err)) {
      try {
        const refreshed = await getJwks({ forceRefresh: true });
        ({ payload } = await tryVerify(refreshed));
      } catch (retryErr) {
        logger.debug("oidc: verifyEndUserAccessToken retry-after-refresh failed", {
          module: "oidc",
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
        return null;
      }
    } else {
      logger.debug("oidc: verifyEndUserAccessToken failed", {
        module: "oidc",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  if (!payload.sub) return null;
  const extra = payload as Record<string, unknown>;
  const actorType =
    extra.actor_type === "dashboard_user" || extra.actor_type === "end_user"
      ? (extra.actor_type as "dashboard_user" | "end_user")
      : undefined;
  const orgRole =
    typeof extra.org_role === "string" &&
    (extra.org_role === "owner" ||
      extra.org_role === "admin" ||
      extra.org_role === "member" ||
      extra.org_role === "viewer")
      ? (extra.org_role as "owner" | "admin" | "member" | "viewer")
      : undefined;
  return {
    authUserId: payload.sub,
    actorType,
    email: typeof extra.email === "string" ? extra.email : undefined,
    emailVerified: typeof extra.email_verified === "boolean" ? extra.email_verified : undefined,
    name: typeof extra.name === "string" ? extra.name : undefined,
    scope: typeof extra.scope === "string" ? extra.scope : undefined,
    orgId: typeof extra.org_id === "string" ? extra.org_id : undefined,
    orgRole,
    applicationId: typeof extra.application_id === "string" ? extra.application_id : undefined,
    endUserId: typeof extra.end_user_id === "string" ? extra.end_user_id : undefined,
  };
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
  _cache = resolver ? { resolver, expiresAt: Date.now() + JWKS_CACHE_TTL_MS } : null;
  _pendingRefresh = null;
}
