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

import { createAuthMiddleware, APIError, getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { db } from "@appstrate/db/client";
import { getRateLimiterFactory } from "../../../infra/index.ts";
import { getClientIpFromRequest } from "../../../lib/client-ip.ts";
import { oauthClient } from "../schema.ts";
import { loadClientSignupPolicy } from "../services/orgmember-mapping.ts";
import { readPendingClientCookieFromHeaders } from "../services/pending-client-cookie.ts";
import {
  assertUserRealm,
  expectedRealmForClient,
  type ClientAudienceMetadata,
} from "./realm-check.ts";

const TOKEN_RL_POINTS = 30;
const AUTHORIZE_RL_POINTS = 30;
const INTROSPECT_RL_POINTS = 60;
const REVOKE_RL_POINTS = 60;
// CLI device flow — per-IP limits on the BA-mounted endpoints. A single
// CLI session polls `/device/token` roughly once per `interval` (5s) up to
// `expiresIn` (10 min = ~120 polls). 30/min/IP comfortably accommodates
// one CLI per IP while capping poll-storms or brute-force probing of
// active device codes. `/device/code` is a write (inserts a row) and
// rarely called more than once per login; 10/min/IP is a loose ceiling.
const DEVICE_CODE_RL_POINTS = 10;
const DEVICE_TOKEN_RL_POINTS = 30;

/**
 * Per-client_id brute-force limit on `/oauth2/token`. Complements the
 * per-IP limiter above: an attacker distributing a `client_secret`
 * brute-force attack across many IPs (or spoofing XFF behind a
 * misconfigured `TRUST_PROXY`) is constrained by this secondary limit
 * keyed on `client_id` alone. Legitimate satellites exchange codes at a
 * rate far below this ceiling; anything approaching 20 attempts/minute
 * per client_id is either a misbehaving client or an attack.
 */
const TOKEN_CLIENT_RL_POINTS = 20;

const LOGIN_EMAIL_POINTS = 5;
const LOGIN_EMAIL_DURATION_SEC = 900;

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

let loginEmailLimiter: RateLimiterAbstract | null = null;
async function getLoginEmailLimiter(): Promise<RateLimiterAbstract> {
  if (!loginEmailLimiter) {
    const factory = await getRateLimiterFactory();
    loginEmailLimiter = await factory.create(
      LOGIN_EMAIL_POINTS,
      LOGIN_EMAIL_DURATION_SEC,
      "rl:oidc:login-email:",
    );
  }
  return loginEmailLimiter;
}

function normalizeLoginEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Test helper — drops cached limiters between runs. */
export function resetOidcGuardsLimiters(): void {
  limiterCache.clear();
  loginEmailLimiter = null;
}

export interface LoginEmailLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Reserve one attempt for a given email on the login rate-limiter. Safe to
 * call before `signInEmail` — reset on successful authentication via
 * `resetLoginEmailAttempts`.
 */
export async function consumeLoginEmailAttempt(email: string): Promise<LoginEmailLimitResult> {
  const limiter = await getLoginEmailLimiter();
  try {
    await limiter.consume(normalizeLoginEmailKey(email));
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (rej) {
    const retry =
      rej && typeof rej === "object" && "msBeforeNext" in rej
        ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
        : LOGIN_EMAIL_DURATION_SEC;
    return { allowed: false, retryAfterSeconds: Math.max(1, retry) };
  }
}

/** Reset the attempt counter for an email on successful sign-in. */
export async function resetLoginEmailAttempts(email: string): Promise<void> {
  const limiter = await getLoginEmailLimiter();
  try {
    await limiter.delete(normalizeLoginEmailKey(email));
  } catch {
    // Best-effort — rate limit cleanup failures must not block the login.
  }
}

async function enforceRateLimit(
  category: string,
  points: number,
  request: Request | undefined,
): Promise<void> {
  const limiter = await getLimiter(category, points);
  const ip = getClientIpFromRequest(request);
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
  client_id?: string;
}

/**
 * Extract the `client_id` a token request is acting on, either from the
 * parsed body or from HTTP Basic auth header (`client_secret_basic`).
 * Returns `null` if neither path yields a value — the downstream limiter
 * then degrades to IP-only limiting for that specific request.
 */
function extractClientId(body: TokenRequestBody, request: Request | undefined): string | null {
  if (typeof body.client_id === "string" && body.client_id.length > 0) return body.client_id;
  const authHeader = request?.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = atob(authHeader.slice(6).trim());
    const sep = decoded.indexOf(":");
    if (sep <= 0) return null;
    return decoded.slice(0, sep);
  } catch {
    return null;
  }
}

async function enforceClientRateLimit(clientId: string): Promise<void> {
  const limiter = await getLimiter("oauth-token-client", TOKEN_CLIENT_RL_POINTS);
  try {
    await limiter.consume(`client:${clientId}`);
  } catch (rej) {
    const retry =
      rej && typeof rej === "object" && "msBeforeNext" in rej
        ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
        : 60;
    throw new APIError(
      "TOO_MANY_REQUESTS",
      {
        error: "rate_limited",
        error_description: `Too many token requests for this client_id. Retry after ${retry}s.`,
      },
      { "Retry-After": String(retry) },
    );
  }
}

/**
 * Build the guards plugin. Returned as an unknown-shaped object at this
 * layer to keep `@better-auth/core` types out of the module's public
 * surface — `oidcBetterAuthPlugins()` merges it into the plugin list.
 */
/**
 * Pre-empt `/magic-link/verify` when the pending OAuth client has a closed
 * signup policy AND the token would create a new user. Produces the same
 * `errorCallbackURL?error=<code>` redirect Better Auth uses natively for
 * its own signup-gating (`disableSignUp` in magic-link, social callback
 * via `oauth2/link-account.mjs` → `callback.mjs:158`), so the OIDC login
 * page can render the localized banner via `mapLoginErrorCode`.
 *
 * Why a pre-check and not the `databaseHooks.user.create.before` guard:
 * BA's magic-link verify does NOT wrap `internalAdapter.createUser` in a
 * try/catch (contrast with `oauth2/link-account.mjs:104` for social and
 * `api/routes/sign-up.mjs:217` for email+password). An `APIError` thrown
 * from the db hook therefore escapes as a raw JSON response instead of
 * being converted into an `errorCallbackURL` redirect. This before-hook
 * looks up the verification token (read-only, no attempt increment) to
 * determine whether the verify would create a new user and short-circuits
 * with the redirect before BA reaches `createUser`. The db hook remains
 * as defense-in-depth for every other signup path.
 */
async function enforceMagicLinkSignupPolicy(ctx: {
  request?: Request;
  query?: unknown;
  context: { baseURL: string; internalAdapter?: unknown };
  redirect: (url: string) => unknown;
}): Promise<void> {
  const pendingClientId = readPendingClientCookieFromHeaders(ctx.request?.headers ?? null);
  if (!pendingClientId) return;

  const policy = await loadClientSignupPolicy(pendingClientId);
  if (!policy) return;
  if (policy.allowSignup) return;

  const query = (ctx.query ?? {}) as {
    token?: string;
    errorCallbackURL?: string;
    callbackURL?: string;
  };
  const token = query.token;
  if (!token) return;

  const adapter = ctx.context.internalAdapter as
    | {
        findVerificationValue: (key: string) => Promise<{ value: string; expiresAt: Date } | null>;
        findUserByEmail: (email: string) => Promise<{ user: unknown } | null>;
      }
    | undefined;
  if (!adapter) return;

  const row = await adapter.findVerificationValue(token);
  if (!row) return;
  let email: string | undefined;
  try {
    const parsed = JSON.parse(row.value) as { email?: unknown };
    if (typeof parsed.email === "string") email = parsed.email;
  } catch {
    return;
  }
  if (!email) return;

  const existing = await adapter.findUserByEmail(email);
  if (existing?.user) return;

  const rawErrorCallback = query.errorCallbackURL ?? query.callbackURL;
  if (!rawErrorCallback) return;
  const target = new URL(decodeURIComponent(rawErrorCallback), ctx.context.baseURL);
  target.searchParams.set("error", "signup_disabled");
  throw ctx.redirect(target.toString());
}

/**
 * Realm-enforcement gate on Better Auth's `/device/approve`.
 *
 * The `deviceAuthorization()` plugin mints BA sessions directly via its
 * internal adapter path — it does NOT flow through `@better-auth/oauth-provider`,
 * so `customAccessTokenClaims` (where `assertUserRealm` normally fires
 * for `/oauth2/token`) never runs for device-flow approvals. Without this
 * hook, an end-user of application X (realm=`"end_user:<appId>"`) could
 * approve an `appstrate-cli` (level=`"instance"`) device code and obtain
 * a session attached to their identity. The session would be blocked by
 * `requirePlatformRealm` on every subsequent platform request — but the
 * right place to reject the cross-audience attempt is here, at the first
 * moment we know both the approving user AND the target client. Mirrors
 * the level→realm dispatch inside `plugins.ts::buildClaimsForClient`.
 *
 * Also runs on `/device/deny` so a correctly-provisioned realm is
 * required even to refuse — avoids a cross-audience user being able to
 * deny someone else's device code through confused-deputy semantics.
 */
async function enforceDeviceApproveRealm(ctx: {
  request?: Request;
  body?: unknown;
  context: unknown;
}): Promise<void> {
  const session = await getSessionFromCtx(ctx as Parameters<typeof getSessionFromCtx>[0]);
  if (!session) {
    throw new APIError("UNAUTHORIZED", {
      error: "unauthorized",
      error_description: "You must be signed in to approve or deny a device authorization.",
    });
  }

  const body = (ctx.body ?? {}) as { userCode?: unknown };
  const rawUserCode = typeof body.userCode === "string" ? body.userCode : "";
  const cleanUserCode = rawUserCode.replace(/-/g, "");
  if (!cleanUserCode) {
    // Let BA's own handler produce the canonical validation error. If we
    // threw here we'd mask it.
    return;
  }

  // Adapter shape from Better Auth's request context — matches what
  // `deviceAuthorization()` itself uses internally. Typed loosely to
  // avoid pulling in `@better-auth/core` internals.
  const adapter = (ctx.context as { adapter?: { findOne?: (args: unknown) => Promise<unknown> } })
    .adapter;
  if (!adapter?.findOne) return;
  const record = (await adapter.findOne({
    model: "deviceCode",
    where: [{ field: "userCode", value: cleanUserCode }],
  })) as { id?: string; clientId?: string | null; status?: string } | null;
  // Unknown code / already-processed / expired — defer to BA's own
  // handler (runs next) to produce the canonical error response.
  if (!record || !record.clientId || record.status !== "pending") return;

  const [client] = await db
    .select({ metadata: oauthClient.metadata, level: oauthClient.level })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, record.clientId))
    .limit(1);
  if (!client) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_client",
      error_description: "The OAuth client associated with this device code no longer exists.",
    });
  }

  let metadata: ClientAudienceMetadata = { level: client.level as ClientAudienceMetadata["level"] };
  if (client.metadata) {
    try {
      const parsed = JSON.parse(client.metadata) as Partial<ClientAudienceMetadata>;
      metadata = { ...metadata, ...parsed };
    } catch {
      // Corrupt metadata → fall back to column level only. expectedRealmForClient
      // will reject if level is missing/unknown, which is the safer path.
    }
  }

  const expected = expectedRealmForClient(metadata);
  await assertUserRealm(session.user.id, expected, {
    clientLevel: metadata.level ?? "unknown",
    applicationId: metadata.referencedApplicationId ?? null,
    orgId: metadata.referencedOrgId ?? null,
  });
}

export function oidcGuardsPlugin(opts: OidcGuardsOptions) {
  const audiences = [...opts.validAudiences];

  return {
    id: "oidc-guards",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/magic-link/verify",
          handler: createAuthMiddleware(enforceMagicLinkSignupPolicy),
        },
        {
          matcher: (ctx: { path?: string }) =>
            ctx.path === "/device/approve" || ctx.path === "/device/deny",
          handler: createAuthMiddleware(enforceDeviceApproveRealm),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/device/code",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("device-code", DEVICE_CODE_RL_POINTS, ctx.request);
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/device/token",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("device-token", DEVICE_TOKEN_RL_POINTS, ctx.request);
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("oauth-token", TOKEN_RL_POINTS, ctx.request);

            const body = (ctx.body ?? {}) as TokenRequestBody;
            // Per-client_id throttle on top of per-IP — protects against
            // distributed `client_secret` brute-force that spreads the
            // attack across many source IPs (or bypasses per-IP limits
            // entirely via XFF spoofing behind a misconfigured
            // TRUST_PROXY). Keyed on `client_id` so a single
            // misbehaving / compromised satellite is rate-limited
            // regardless of where its requests come from.
            const clientId = extractClientId(body, ctx.request);
            if (clientId) await enforceClientRateLimit(clientId);

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
