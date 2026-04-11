// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugin — `/oauth2/*` production guards.
 *
 * The `@better-auth/oauth-provider` plugin mounts `/oauth2/token`,
 * `/oauth2/authorize`, `/oauth2/introspect`, `/oauth2/revoke` directly under
 * Better Auth's base path. Hono's outer `app.on("/api/auth/*", auth.handler)`
 * catches every call to those routes before any module router can intercept,
 * so the only clean hook point is a Better Auth plugin.
 *
 * This plugin uses `hooks.before` to run two checks before Better Auth
 * dispatches to the oauth-provider endpoints:
 *
 * 1. **Resource enforcement (RFC 8707)** — `/oauth2/token` grants
 *    `authorization_code` and `refresh_token` MUST carry a `resource` param
 *    matching one of `validAudiences`. Without it, `createUserTokens`
 *    silently falls back to opaque tokens that our `Bearer ey...` strategy
 *    cannot match — every subsequent scoped request 401s with no hint.
 *    We reject up-front with a clear `invalid_request` so satellites get
 *    a diagnosable error instead of a silent-fail cascade.
 *
 * 2. **IP rate limiting** — `/oauth2/token`, `/oauth2/authorize`,
 *    `/oauth2/introspect`, `/oauth2/revoke` are all unauthenticated and
 *    reachable by any client. Without IP-based limits, an attacker can
 *    brute-force `client_secret` at the token endpoint, enumerate
 *    `client_id`s at authorize, or probe tokens at introspect. We reuse
 *    the same `rate-limiter-flexible` Redis backend the rest of the API
 *    uses so limits are distributed across instances.
 *
 * Error shape: rejections throw `better-call`'s `APIError` which Better
 * Auth surfaces as the appropriate HTTP status with an OAuth2-style body.
 */

import { createAuthMiddleware, APIError } from "better-auth/api";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { getRateLimiterFactory } from "../../../infra/index.ts";

const TOKEN_RL_POINTS = 30;
const AUTHORIZE_RL_POINTS = 30;
const INTROSPECT_RL_POINTS = 60;
const REVOKE_RL_POINTS = 60;

const limiterCache = new Map<string, RateLimiterAbstract>();

async function getLimiter(category: string, points: number): Promise<RateLimiterAbstract> {
  const cacheKey = `${category}:${points}`;
  let limiter = limiterCache.get(cacheKey);
  if (!limiter) {
    const factory = await getRateLimiterFactory();
    limiter = await factory.create(points, 60, `rl:oidc:${category}:`);
    limiterCache.set(cacheKey, limiter);
  }
  return limiter;
}

/** Test helper — drops cached limiters between runs. */
export function resetOidcGuardsLimiters(): void {
  limiterCache.clear();
}

function extractIp(request: Request | undefined): string {
  if (!request) return "unknown";
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

async function enforceRateLimit(
  category: string,
  points: number,
  request: Request | undefined,
): Promise<void> {
  const limiter = await getLimiter(category, points);
  const ip = extractIp(request);
  try {
    await limiter.consume(`${category}:${ip}`);
  } catch (rej) {
    const retry =
      rej && typeof rej === "object" && "msBeforeNext" in rej
        ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
        : 60;
    throw new APIError(
      "TOO_MANY_REQUESTS",
      {
        error: "rate_limited",
        error_description: `Too many requests to ${category}. Retry after ${retry}s.`,
      },
      { "Retry-After": String(retry) },
    );
  }
}

interface OidcGuardsOptions {
  /** Audiences accepted as the RFC 8707 `resource` parameter. */
  validAudiences: readonly string[];
}

interface TokenRequestBody {
  grant_type?: string;
  resource?: string | string[];
}

/**
 * Build the guards plugin. Returned as an unknown-shaped object at this
 * layer to keep `@better-auth/core` types out of the module's public
 * surface — `oidcBetterAuthPlugins()` merges it into the plugin list.
 */
export function oidcGuardsPlugin(opts: OidcGuardsOptions) {
  const audiences = [...opts.validAudiences];

  return {
    id: "oidc-guards",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("oauth-token", TOKEN_RL_POINTS, ctx.request);

            const body = (ctx.body ?? {}) as TokenRequestBody;
            const grantType = body.grant_type;
            if (grantType === "authorization_code" || grantType === "refresh_token") {
              const resource = Array.isArray(body.resource) ? body.resource[0] : body.resource;
              if (!resource || !audiences.includes(resource)) {
                throw new APIError("BAD_REQUEST", {
                  error: "invalid_request",
                  error_description:
                    `The 'resource' parameter is required (RFC 8707) and must be one of: ${audiences.join(", ")}. ` +
                    `Without it, the plugin issues opaque access tokens that the Appstrate Bearer auth strategy cannot verify.`,
                });
              }
            }
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("oauth-authorize", AUTHORIZE_RL_POINTS, ctx.request);
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/introspect",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("oauth-introspect", INTROSPECT_RL_POINTS, ctx.request);
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/revoke",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("oauth-revoke", REVOKE_RL_POINTS, ctx.request);
          }),
        },
      ],
    },
  };
}
