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
import { and, eq, sql } from "drizzle-orm";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { db } from "@appstrate/db/client";
import { getRateLimiterFactory } from "../../../infra/index.ts";
import { getClientIpFromRequest } from "../../../lib/client-ip.ts";
import { deviceCode, oauthClient } from "../schema.ts";
import { logger } from "../../../lib/logger.ts";
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
// CLI token endpoints (issue #165). `/cli/token` serves the SAME poll
// cadence `/device/token` does during device flow (once per interval →
// ~120 polls over 10 min) AND the silent-refresh path (once per ~15 min
// per active CLI). 30/min/IP is symmetric with DEVICE_TOKEN and covers
// both patterns. `/cli/revoke` is only called on `appstrate logout` and
// is idempotent, but we cap it too to close any DoS vector on the
// family-revocation UPDATE.
const CLI_TOKEN_RL_POINTS = 30;
const CLI_REVOKE_RL_POINTS = 30;
// Per-IP budget on Better Auth's `GET /device?user_code=…` endpoint
// (mounted by `deviceAuthorization()` — see
// `node_modules/better-auth/dist/plugins/device-authorization/routes.mjs:285-337`,
// public, no auth, returns the device code's `status` for a given
// `user_code`). Without a guard here this becomes an unrate-limited
// user_code probe endpoint: an attacker can enumerate the ~34.6-bit
// user_code space looking for a `pending` row before the legitimate
// user reaches the consent screen, then race them to `/device/approve`
// (where the realm guard + per-row attempts counter take over).
//
// Happy-path traffic audit (grep anchor for future operators surprised
// by a 429 on `/device`):
//   - `/device` is consumed SERVER-SIDE only by the `/activate` SSR
//     page (`apps/api/src/modules/oidc/pages/activate.ts`) at consent
//     render — one GET per device-authorization session, from the
//     platform's own IP.
//   - The web SPA (`apps/web/src/`) does NOT call `/device`; there is
//     no `fetch("/device")` in the client bundle.
//   - The CLI client does NOT poll `/device` either — it polls
//     `/device/token`, covered by `DEVICE_TOKEN_RL_POINTS = 30`.
// Net: legit flows cost 1 hit/session, so 10/min/IP is intentionally
// generous for legit traffic and tight against probe enumeration.
const DEVICE_VERIFY_RL_POINTS = 10;
// Per-IP budget on the BA-mounted `/device/approve` and `/device/deny`
// endpoints. The SSR wrapper at `/activate/approve` already has its own
// stricter limiter (5 / 15 min / IP via `rateLimitByIp`) but the direct
// BA routes accept the same JSON body from any authenticated caller, so
// a per-IP ceiling here closes the remaining online-guessing surface
// against the 20⁸ ≈ 34.6-bit user_code space. 10/min/IP is tight enough
// that a single attacker cannot materially erode the birthday bound
// against the set of active codes, while leaving legitimate users ample
// headroom (a browser typically issues a single POST per approval).
const DEVICE_APPROVE_RL_POINTS = 10;
// Per-row brute-force lockout on `/device/approve` + `/device/deny`.
// Covers the post-lookup attack path: once an attacker knows a valid
// user_code (leaked / shoulder-surfed / partial disclosure) they cannot
// keep retrying realm mismatches across different accounts until one
// lands in the right audience. 5 failed attempts retire the row — the
// legit user requests a fresh code and keeps the happy-path cost to a
// single browser click. Pure brute-force of the 20⁸ user-code space is
// separately constrained by the per-IP rate limits on these endpoints.
const MAX_APPROVE_ATTEMPTS = 5;

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
  // Group IP-less calls into a single bucket so a flood of unauthenticated
  // device-flow polls from a sourceless transport still hits the limit.
  const ip = getClientIpFromRequest(request) ?? "unknown";
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
      { "Retry-After": String(retry), "X-RateLimit-Scope": "ip" },
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
    // Log the discriminator internally so operators can triage which
    // limiter fired without surfacing the keying strategy in the
    // response body. Externally we emit the same generic
    // `error_description` as `enforceRateLimit` — an attacker probing
    // rate limits can infer SOME limit exists from the 429, but giving
    // them "we key on client_id" in plaintext makes it trivial to plan
    // the distributed-IP bypass the secondary limiter is meant to
    // catch. The distinguishing `X-RateLimit-Scope` header lets tests
    // assert which limiter fired without leaking the info to anonymous
    // token-endpoint callers who already know they were throttled.
    logger.warn("oidc: /oauth2/token per-client rate limit tripped", {
      module: "oidc",
      audit: true,
      event: "oauth.token.rate_limited.client",
      clientId,
      retryAfterSeconds: retry,
    });
    throw new APIError(
      "TOO_MANY_REQUESTS",
      {
        error: "rate_limited",
        error_description: `Too many token requests. Retry after ${retry}s.`,
      },
      { "Retry-After": String(retry), "X-RateLimit-Scope": "client" },
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
export async function enforceMagicLinkSignupPolicy(ctx: {
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
  const baseURL = new URL(ctx.context.baseURL);

  // Shared fallback — used both for off-origin URLs (attack path:
  // attacker-controlled absolute URL that would open-redirect) and for
  // unparseable input (attack path: `%ZZ` / lone `%` / malformed URL
  // surfaces an uncaught URIError/TypeError as a 500 instead of a clean
  // redirect; a 500 is itself a minor oracle distinguishing "hook fired
  // and choked" from "hook did not fire"). Both paths converge on an
  // in-origin redirect carrying `?error=signup_disabled` so the OIDC
  // login page still renders the localized banner via `mapLoginErrorCode`.
  // Typed `never` so TypeScript narrows `target` after the try/catch.
  // Explicit `function` declaration (rather than arrow) because TS
  // propagates the `never` annotation from a declared-function return
  // position more reliably than from a `const foo = (...): never => …`
  // expression — the latter can fail to narrow `target` at the callsite
  // even though the body always throws.
  function redirectToSafeDefault(auditEvent: string, logFields: Record<string, unknown>): never {
    logger.warn("oidc: magic-link signup gate falling back to safe redirect", {
      module: "oidc",
      audit: true,
      event: auditEvent,
      ...logFields,
    });
    const safe = new URL(baseURL);
    safe.searchParams.set("error", "signup_disabled");
    throw ctx.redirect(safe.toString());
  }

  // `decodeURIComponent` throws `URIError` on malformed percent-escapes
  // (`%ZZ`, lone `%`); `new URL` throws `TypeError` on syntactically
  // invalid URLs (`https://[bracket-without-close`, control chars, …).
  // Neither is a security regression on its own — we never hand session
  // material to an attacker-controlled origin — but letting the throw
  // escape converts the intended `?error=signup_disabled` redirect into
  // an opaque 500, which is both ugly UX and a weak oracle for an
  // attacker who can plant a pending-client cookie and trigger this
  // path. Convert to the same safe in-origin redirect as the off-origin
  // branch below. Truncate the raw value in the log field so we don't
  // pipe unbounded attacker-controlled payloads through the log pipeline.
  let target: URL;
  try {
    target = new URL(decodeURIComponent(rawErrorCallback), baseURL);
  } catch (err) {
    redirectToSafeDefault("oidc.magic_link.error_callback.unparseable", {
      rawErrorCallback: rawErrorCallback.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Same-origin gate on the redirect target. Better Auth's own
  // `originCheck` middleware (registered via `use:` on the magic-link
  // verify route — see `node_modules/better-auth/dist/plugins/magic-link/
  // index.mjs:87-95`) validates `errorCallbackURL` against
  // `trustedOrigins` BEFORE running the route handler. BUT plugin
  // `hooks.before` fire BEFORE `use:` middlewares (see
  // `node_modules/better-auth/dist/api/to-auth-endpoints.mjs:74,100` —
  // `runBeforeHooks` precedes `endpoint(...)` which executes the
  // route's `use:` chain). That means at this point the URL is still
  // attacker-controlled: an absolute `errorCallbackURL=https://evil/x`
  // would resolve through `new URL(rawErrorCallback, baseURL)` to
  // `https://evil/x` and be passed to `ctx.redirect()`, producing an
  // authenticated open-redirect (attacker-controlled domain receiving
  // a navigation that originates from the magic-link click flow,
  // useful for branded phishing). The exploit window is narrow — only
  // triggers when a pending OAuth client cookie is present AND its
  // signup policy is closed AND the email is new — but the cost of
  // closing it is one origin comparison.
  //
  // Fail-closed: any URL that resolves outside `baseURL.origin` is
  // dropped and we redirect to a safe in-origin default. Logged at
  // warn so operators can spot misconfigured callers (legit clients
  // should always pass a same-origin URL); the normalized response
  // still carries `?error=signup_disabled` so the OIDC login page can
  // render the localized banner via `mapLoginErrorCode`.
  if (target.origin !== baseURL.origin) {
    redirectToSafeDefault("oidc.magic_link.error_callback.off_origin", {
      attemptedOrigin: target.origin,
      baseOrigin: baseURL.origin,
    });
  }
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

  // Direct Drizzle lookup rather than the BA internal adapter — the
  // adapter shape is an internal BA contract and silently degrading if
  // it ever changes would turn this guard into a no-op. Reading from
  // the same `device_codes` table BA writes to keeps the check anchored
  // on authoritative state.
  //
  // Correctness relies on the schema-level UNIQUE constraint on
  // `device_codes.user_code` (see `schema.ts::deviceCode` and migration
  // `0004_device_codes.sql`). Without it, two concurrently-issued rows
  // could share a `user_code` and `.limit(1)` would silently mask the
  // collision — picking an arbitrary row whose `clientId` may not match
  // the one the legit user is approving. The UNIQUE B-tree also serves
  // every `WHERE userCode = ?` lookup in this file (the SELECT here, the
  // increment UPDATE, and the lockout UPDATE below).
  const [record] = await db
    .select({ clientId: deviceCode.clientId, status: deviceCode.status })
    .from(deviceCode)
    .where(eq(deviceCode.userCode, cleanUserCode))
    .limit(1);
  // Unknown code / already-processed / expired — defer to BA's own
  // handler (runs next) to produce the canonical error response.
  if (!record || !record.clientId || record.status !== "pending") return;

  // Atomically bump the per-row attempt counter BEFORE the realm check
  // runs so every probe counts, including cross-audience attempts that
  // the guard below will refuse. The counter is returned post-increment
  // so we can lock the row at the exact threshold without a read-modify-
  // write window. When a legit user succeeds, BA's handler flips the
  // status to `approved` right after this hook returns — further probes
  // fail at the status check above, not at the counter.
  //
  // The UPDATE is guarded by `status = 'pending'` to close the
  // SELECT-then-UPDATE TOCTOU window: between the SELECT above and this
  // statement, a concurrent request can flip status to `approved` /
  // `denied` (BA's own handler runs immediately after our hook returns
  // for a successful approval). Without the predicate we'd waste a
  // write incrementing `attempts` on an already-decided row, and the
  // post-increment lockout block below would needlessly evaluate
  // `bumped.attempts > MAX` against a now-irrelevant counter. With the
  // predicate, the UPDATE hits 0 rows when status has flipped,
  // `returning()` yields `[]`, `bumped` is undefined, and we short-
  // circuit — leaving BA's own handler (which runs next) to produce
  // the canonical "code already processed" error.
  //
  // Documented trade-off: an authenticated user who learns a victim's
  // `user_code` (shoulder surf, leaked screenshot, CLI log copy-paste)
  // can burn it in 5 wrong-realm POSTs — the row transitions to `denied`
  // and the legit user has to request a fresh code. This is a minor DoS,
  // not a compromise (no token is ever minted to the attacker), and the
  // recovery is one CLI re-run. Moving the increment AFTER the realm
  // check would close the burn-the-code window but open the symmetric
  // one: an attacker in the right realm could now iterate the ~34.6-bit
  // code space without ever being counted. Counting pre-check is the
  // safer default; the CLI's `user_code` entropy (8 chars, 20-letter
  // alphabet) + per-IP rate limits on this endpoint (10/min/IP via
  // `DEVICE_APPROVE_RL_POINTS`) + the SSR wrapper's stricter 5/15min/IP
  // keep the attack surface bounded.
  const [bumped] = await db
    .update(deviceCode)
    .set({ attempts: sql`${deviceCode.attempts} + 1` })
    .where(and(eq(deviceCode.userCode, cleanUserCode), eq(deviceCode.status, "pending")))
    .returning({ attempts: deviceCode.attempts });

  // Row flipped to approved/denied between our SELECT and this UPDATE —
  // defer to BA's own handler (runs next) to produce the canonical
  // "already processed" error. We must NOT throw our own error here:
  // the legit user might have just clicked approve from another tab,
  // and surfacing an `access_denied` from this guard would mask BA's
  // semantically-correct response.
  if (!bumped) return;

  if (bumped.attempts > MAX_APPROVE_ATTEMPTS) {
    // Retire the row so even a later correct-realm attempt (whether the
    // legit user or the attacker's last guess) is refused. Guarded with
    // `status = 'pending'` so we don't clobber a row that BA's handler
    // just flipped to `approved` in a parallel request.
    await db
      .update(deviceCode)
      .set({ status: "denied" })
      .where(and(eq(deviceCode.userCode, cleanUserCode), eq(deviceCode.status, "pending")));
    logger.warn("oidc: device approve locked out after too many failed attempts", {
      module: "oidc",
      audit: true,
      event: "cli.device.approve.locked_out",
      clientId: record.clientId,
      userId: session.user.id,
      attempts: bumped.attempts,
    });
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description:
        "Too many failed approval attempts for this device code. Request a new code from the CLI.",
    });
  }

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
    } catch (err) {
      // Corrupt metadata → fall back to column level only.
      // `expectedRealmForClient` will reject if level is missing or
      // unknown, which is the safer path. Surface the drift so operators
      // can repair the row instead of it lingering silently.
      logger.warn("oidc: oauth_clients.metadata JSON is corrupt — falling back to column level", {
        module: "oidc",
        clientId: record.clientId,
        error: err instanceof Error ? err.message : String(err),
      });
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
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("device-approve", DEVICE_APPROVE_RL_POINTS, ctx.request);
          }),
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
          // Issue #165 — rate-limit the CLI's JWT + rotating-refresh
          // endpoints the same way we limit the legacy `/device/token`.
          // `/cli/token` handles both the initial device-code → tokens
          // exchange AND refresh-token rotation (discriminated by
          // `grant_type` in the body); one ceiling covers both because
          // legit traffic for either pattern is far under 30/min/IP.
          matcher: (ctx: { path?: string }) => ctx.path === "/cli/token",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("cli-token", CLI_TOKEN_RL_POINTS, ctx.request);
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/cli/revoke",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("cli-revoke", CLI_REVOKE_RL_POINTS, ctx.request);
          }),
        },
        {
          // BA's device-authorization plugin exposes `GET /device?user_code=…`
          // for the SSR consent page to look up the status of a code. Public,
          // no auth — without this guard it is an unrate-limited user_code
          // probe surface. See `DEVICE_VERIFY_RL_POINTS` above for the
          // rationale. The exact path is `/device` (not `/device/verify`),
          // matching the upstream endpoint registration in
          // `better-auth@1.6.5/plugins/device-authorization/routes.mjs:285`.
          matcher: (ctx: { path?: string }) => ctx.path === "/device",
          handler: createAuthMiddleware(async (ctx) => {
            await enforceRateLimit("device-verify", DEVICE_VERIFY_RL_POINTS, ctx.request);
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
