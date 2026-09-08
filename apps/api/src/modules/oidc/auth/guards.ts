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
 *    `authorization_code` and `refresh_token` MUST carry a `resource` param.
 *    Whether a given resource EXISTS is the oauth-provider's own call (it
 *    resolves each one against `oauth_resources` and answers `invalid_target`);
 *    what it does not do is REQUIRE one. Without a `resource`, `createUserTokens`
 *    silently falls back to opaque tokens that our `Bearer ey...` strategy
 *    cannot match — every subsequent scoped request 401s with no hint.
 *    We reject up-front with a clear `invalid_request` so satellites get
 *    a diagnosable error instead of a silent-fail cascade. On top of that we
 *    confine self-service (DCR / CIMD) clients to exactly one protected
 *    resource — a rule with no upstream equivalent.
 *
 * 2. **Rate limiting the endpoints upstream does not cover** — the
 *    `/oauth2/*` endpoints are limited per IP by the oauth-provider's own
 *    rules (`oauthProvider({ rateLimit })` in `plugins.ts`), applied against
 *    the platform's shared limiter. What has no upstream rule stays here:
 *    the device-flow and CLI-token endpoints.
 *
 * 3. **Registration defaults** — `/oauth2/register` bodies get the
 *    `application_type` the oauth-provider exposes no option to default,
 *    so RFC 7591 registrants reach the same redirect-URI rules as CIMD ones
 *    (see `defaultRegistrationToNativeClient`).
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
import { deviceCode, oauthClient } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";
import { loadClientSignupPolicy } from "../services/orgmember-mapping.ts";
import { markClientSelfService } from "../services/oauth-admin.ts";
import { isProtectedResourceUri } from "../../../lib/protected-resources.ts";
import {
  resolvePendingClientBinding,
  MAGIC_LINK_VERIFY_PATH,
} from "../services/oauth-transaction-binding.ts";
import {
  assertUserRealm,
  expectedRealmForClient,
  type ClientAudienceMetadata,
} from "./realm-check.ts";
import { getErrorMessage } from "@appstrate/core/errors";

// The categories below have no upstream rule, and Better Auth answers a 429
// with `{ message }` + `X-Retry-After` where these answer the RFC 8628 /
// RFC 6749 `{ error, error_description }` + `Retry-After` the CLI parses
// (`apps/cli/src/lib/device-flow.ts`), so they stay local.
//
// CLI device flow — per-IP limit on `/device/code`. The endpoint is a
// write (inserts a row) and rarely called more than once per login;
// 10/min/IP is a loose ceiling.
const DEVICE_CODE_RL_POINTS = 10;
// CLI token endpoints (issue #165). `/cli/token` serves both the device-
// code → tokens exchange (once per interval ≈ 5s, ~120 polls over 10 min)
// AND the silent-refresh path (once per ~15 min per active CLI). 30/min/IP
// covers both patterns. `/cli/revoke` is only called on `appstrate logout`
// and is idempotent, but we cap it too to close any DoS vector on the
// family-revocation UPDATE.
const CLI_TOKEN_RL_POINTS = 30;
const CLI_REVOKE_RL_POINTS = 30;
// `GET /device?user_code=…` carries no rule here: `deviceAuthorization()`
// declares its own (`window: expiresIn`, `max: 5` — 5 probes per 10 minutes
// per IP against the ~34.6-bit user_code space), which is tighter than any
// per-minute budget this file could state. The `/activate` SSR page reaches
// the endpoint through `getOidcAuthApi().deviceVerify()`, an in-process call
// that never passes the handler, so the rule costs legitimate consent
// renders nothing.
//
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

const LOGIN_EMAIL_POINTS = 5;
const LOGIN_EMAIL_DURATION_SEC = 900;

const limiterCache = new Map<string, RateLimiterAbstract>();

async function getLimiter(category: string, points: number): Promise<RateLimiterAbstract> {
  const cacheKey = `${category}:${points}`;
  let limiter = limiterCache.get(cacheKey);
  if (!limiter) {
    const factory = await getRateLimiterFactory();
    limiter = factory.create(points, 60, `rl:oidc:${category}:`);
    limiterCache.set(cacheKey, limiter);
  }
  return limiter;
}

let loginEmailLimiter: RateLimiterAbstract | null = null;
async function getLoginEmailLimiter(): Promise<RateLimiterAbstract> {
  if (!loginEmailLimiter) {
    const factory = await getRateLimiterFactory();
    loginEmailLimiter = factory.create(
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

interface LoginEmailLimitResult {
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

interface TokenRequestBody {
  grant_type?: string;
  resource?: string | string[];
  client_id?: string;
}

/**
 * Extract the `client_id` a token request is acting on, either from the
 * parsed body or from the HTTP Basic auth header (`client_secret_basic`).
 * Returns `null` if neither path yields a value — the self-service audience
 * rule then has no client to resolve and leaves the request to the
 * oauth-provider, which rejects an unidentifiable client itself.
 */
function extractClientId(body: TokenRequestBody, request: Request | undefined): string | null {
  if (typeof body.client_id === "string" && body.client_id.length > 0) return body.client_id;
  const authHeader = request?.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = atob(authHeader.slice(6).trim());
    const sep = decoded.indexOf(":");
    if (sep <= 0) return null;
    // RFC 6749 §2.3.1: the `client_id` and `client_secret` are
    // `application/x-www-form-urlencoded` BEFORE being joined with `:` and
    // base64-encoded. Reverse that here (`+` → space, then percent-decode) so
    // a client_id containing reserved characters resolves to its true value
    // rather than its still-encoded form. `decodeURIComponent` throws on a
    // malformed `%` sequence — the enclosing try/catch answers `null`.
    const rawClientId = decoded.slice(0, sep);
    return decodeURIComponent(rawClientId.replace(/\+/g, " "));
  } catch {
    return null;
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
  const query = (ctx.query ?? {}) as {
    token?: string;
    errorCallbackURL?: string;
    callbackURL?: string;
  };
  const token = query.token;
  if (!token) return;

  // Resolve the in-flight client from the TRANSACTION BINDING (the
  // `(token → client)` record persisted at issuance) — same source as the
  // realm resolver and the db-hook signup guard, and no cookie fallback on
  // this leg (see `services/oauth-transaction-binding.ts`, CRIT-15).
  const binding = await resolvePendingClientBinding({
    headers: ctx.request?.headers ?? null,
    path: MAGIC_LINK_VERIFY_PATH,
    query,
  });
  if (binding.kind !== "bound") return;
  const pendingClientId = binding.clientId;

  const policy = await loadClientSignupPolicy(pendingClientId);
  if (!policy) return;
  if (policy.allowSignup) return;

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
      error: getErrorMessage(err),
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
 * hook, an end-user of space X (realm=`"end_user:<spaceId>"`) could
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
  // `device_codes.user_code` (see `schema/oidc.ts::deviceCode` and migration
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

  // Columns, not the `metadata` JSON: that JSON is provider-owned and a
  // registration body may set it, so a realm derived from it is a realm the
  // client names.
  const [client] = await db
    .select({
      level: oauthClient.level,
      referencedOrgId: oauthClient.referencedOrgId,
      referencedSpaceId: oauthClient.referencedSpaceId,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, record.clientId))
    .limit(1);
  if (!client) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_client",
      error_description: "The OAuth client associated with this device code no longer exists.",
    });
  }

  const metadata: ClientAudienceMetadata = {
    level: client.level,
    referencedOrgId: client.referencedOrgId ?? undefined,
    referencedSpaceId: client.referencedSpaceId ?? undefined,
  };
  const expected = expectedRealmForClient(metadata);
  await assertUserRealm(session.user.id, expected, {
    clientLevel: metadata.level ?? "unknown",
    spaceId: metadata.referencedSpaceId ?? null,
    orgId: metadata.referencedOrgId ?? null,
  });
}

/**
 * Whether `clientId` registered itself (DCR / CIMD) — the `self_service` column
 * `markClientSelfService` stamps.
 *
 * Such a client mints instance tokens carrying the connecting user's full
 * authority, so the only safe audience is a single protected resource (a per-org
 * MCP endpoint) whose own resource-server check and the outbound confinement in
 * `protected-resources.ts` jointly cage it; the `/oauth2/token` guard enforces
 * that at mint time. A missing row reads as not self-service, so
 * operator-provisioned clients (the dashboard SPA / CLI) keep targeting the
 * platform audience under the other gates.
 */
async function isSelfServiceClient(clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ selfService: oauthClient.selfService })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return row?.selfService === true;
}

/**
 * Default an unspecified `application_type` on the DCR path to `native`.
 *
 * The provider validates every registered redirect URI against the client's
 * application type: a `web` client may only use https on a non-loopback host, a
 * `native` one may use `http://localhost`, `http://127.0.0.1` or `http://[::1]`
 * (RFC 8252 §7.3 / OIDC Dynamic Registration §2), and it assumes `web` for a DCR
 * body that declares nothing. The MCP clients this endpoint exists for —
 * `claude mcp add`, `npx @appstrate/connect-helper` — listen on an ephemeral
 * loopback port and declare no `application_type`, so `web` would refuse every
 * one of them with `invalid_redirect_uri`.
 *
 * Only the absent case is filled, `null` included: a body that names a type
 * keeps it, so a client that says `web` is still held to https non-loopback.
 * The provider exposes no option for this default, hence the hook.
 */
async function defaultRegistrationToNativeClient(ctx: {
  body?: unknown;
}): Promise<{ context: { body: Record<string, unknown> } } | undefined> {
  const body = ctx.body;
  if (!body || typeof body !== "object") return;
  const declared = (body as { application_type?: unknown }).application_type;
  if (declared !== undefined && declared !== null) return;
  return {
    context: { body: { ...(body as Record<string, unknown>), application_type: "native" } },
  };
}

export function oidcGuardsPlugin() {
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
          // Issue #165 — rate-limit the CLI's JWT + rotating-refresh
          // endpoints. `/cli/token` handles both the initial device-code
          // → tokens exchange AND refresh-token rotation (discriminated
          // by `grant_type` in the body); one ceiling covers both because
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
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as TokenRequestBody;
            // The two grants the AS supports (`oauthProvider({ grantTypes })`),
            // both of which mint a user token and may carry a `resource`.
            const grantType = body.grant_type;
            if (grantType === "authorization_code" || grantType === "refresh_token") {
              // `resource` may arrive repeated (RFC 8707 §2); the whole list
              // is kept because the self-service rule below counts it. Each
              // value's existence is checked by the oauth-provider itself —
              // an unknown or disabled identifier gets `invalid_target` there.
              const resources = Array.isArray(body.resource)
                ? body.resource
                : body.resource
                  ? [body.resource]
                  : [];
              if (resources.length === 0) {
                throw new APIError("BAD_REQUEST", {
                  error: "invalid_request",
                  error_description:
                    "The 'resource' parameter is required (RFC 8707) — use the resource URI " +
                    "advertised by the endpoint you are calling. Without it, the plugin issues " +
                    "opaque access tokens that the Appstrate Bearer auth strategy cannot verify.",
                });
              }
              // Self-service (DCR / CIMD) clients carry the connecting user's
              // full authority, so their tokens MUST be confined to a SINGLE
              // protected resource (one per-org MCP endpoint, `/api/mcp/o/:org`)
              // — never the broad platform audience (`APP_URL` / `APP_URL/api/auth`),
              // which would let the token act across the entire REST API, and
              // never several resources at once (a per-org MCP token is bound to
              // exactly ONE org by design — a multi-aud request would smuggle a
              // second org / the platform audience into `aud`). Admin-provisioned
              // instance clients — the dashboard SPA / CLI — are NOT self-service
              // and may target the platform audience. The outbound half of
              // `enforceResourceAudience` then keeps the issued token from being
              // replayed off its resource. No-op when no protected resource is
              // registered (mcp module disabled) — `isProtectedResourceUri` is
              // false for everything, so a self-service client simply cannot mint.
              const clientId = extractClientId(body, ctx.request);
              if (clientId && (await isSelfServiceClient(clientId))) {
                if (resources.length !== 1 || !isProtectedResourceUri(resources[0]!)) {
                  logger.warn(
                    "oidc: self-service client requested a non-resource / multi-resource audience — rejecting",
                    {
                      module: "oidc",
                      audit: true,
                      event: "oauth.token.self_service_audience_rejected",
                      clientId,
                      resources,
                    },
                  );
                  throw new APIError("BAD_REQUEST", {
                    error: "invalid_target",
                    error_description:
                      "A self-service client may bind a token to exactly one protected-resource " +
                      "audience (RFC 8707) — e.g. an MCP org endpoint.",
                  });
                }
              }
            }
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(defaultRegistrationToNativeClient),
        },
      ],
      after: [
        {
          // Stamp the freshly-registered DCR client as a self-service instance
          // client. Done in an AFTER-hook (not before) because the RFC 7591
          // register schema strips unknown body fields — a `metadata` injected
          // before validation never reaches storage. Here we read the
          // generated `client_id` from the response and update the row, the
          // same seam as CIMD's `onClientCreated`. See
          // `markClientSelfService` for why this is required (otherwise token
          // mint rejects the client for a missing `level`).
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = (ctx.context as { returned?: unknown }).returned;
            const clientId =
              returned && typeof returned === "object" && "client_id" in returned
                ? (returned as { client_id?: unknown }).client_id
                : undefined;
            if (typeof clientId === "string" && clientId.length > 0) {
              await markClientSelfService(clientId);
            }
          }),
        },
      ],
    },
  };
}
