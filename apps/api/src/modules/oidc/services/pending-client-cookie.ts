// SPDX-License-Identifier: Apache-2.0

/**
 * Pending-client signed cookie — plumbs the OAuth `client_id` from the
 * server-rendered entry pages (`/api/oauth/login`, `/api/oauth/register`,
 * `/api/oauth/magic-link`) through the subsequent Better Auth round-trip.
 *
 * ROLE (post CRIT-15): the cookie is NOT the authority for realm/signup
 * decisions on the BA-driven create legs anymore — the browser controls
 * whether it presents the cookie, and the single global cookie is clobbered
 * by a concurrent flow in a second tab. Authority lives in the transaction
 * binding (`services/oauth-transaction-binding.ts`): OAuth `state` for the
 * social callback, the single-use token binding for magic-link verify, and
 * the server-authored authoritative cookie header
 * (`headersWithAuthoritativePendingClient`) for the in-process register /
 * magic-link-request paths. The browser cookie remains load-bearing for the
 * per-space social credential override (`ba-social-override-plugin`).
 *
 * Why a cookie and not AsyncLocalStorage: the social sign-in flow bounces the
 * browser off a third-party IdP (Google, GitHub) and lands on
 * `/api/auth/callback/:provider` minutes later — the original Node async
 * context is long gone. A signed cookie survives the redirect chain,
 * requires no server-side state (no Redis key), and is readable from any
 * request that carries it.
 *
 * Security:
 *   - Signed under the auth keyring so a client cannot forge a `clientId`.
 *   - `HttpOnly` to keep it out of JS.
 *   - `SameSite=Lax` — MUST NOT be `Strict`, otherwise the cookie is dropped
 *     on the cross-site POST → redirect from BA's social callback.
 *   - `Secure` conditional on `APP_URL` scheme (same pattern as CSRF).
 *   - 10 minute TTL — enough for a full social round-trip (user typing
 *     password on Google + consent) but short enough that a stale cookie
 *     cannot be replayed weeks later.
 *
 * The cookie is set on `/api/oauth` (the OIDC entry pages issue it) but read
 * on `/api/auth/*` (Better Auth's routes). The `Path=/` attribute covers
 * both.
 */

import { setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { getEnv } from "@appstrate/env";
import { logger } from "../../../lib/logger.ts";
import { signKeyringToken, verifyKeyringToken } from "@appstrate/afps-shared/signed-token";
import { authKeyring } from "../../../lib/auth-secrets.ts";
import type { AppEnv } from "../../../types/index.ts";

let insecureCookieWarned = false;

const COOKIE_NAME = "oidc_pending_client";
const COOKIE_MAX_AGE = 10 * 60; // 10 minutes
const PENDING_CLIENT_TOKEN_DOMAIN = "oidc-pending-client.v1.";

/**
 * Sign `clientId` + `exp` with HMAC-SHA256 and set the cookie. Safe to call
 * multiple times on the same request — the latest call wins (browsers
 * overwrite by (name, path, domain)).
 */
export function issuePendingClientCookie(c: Context<AppEnv>, clientId: string): void {
  const value = buildSignedPendingClientValue(clientId);
  const env = getEnv();
  const secure = env.APP_URL.startsWith("https://");
  if (!secure && process.env.NODE_ENV === "production" && !insecureCookieWarned) {
    // An operator who mistyped `APP_URL` or fronts the platform with HTTP in
    // production will ship the pending-client cookie unencrypted. Warn once
    // per process so it surfaces in logs without flooding.
    logger.warn(
      "oidc: APP_URL is not https in production — pending-client cookie will be sent without Secure flag",
      { appUrl: env.APP_URL },
    );
    insecureCookieWarned = true;
  }
  setCookie(c, COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

/**
 * Read + verify the `oidc_pending_client` cookie directly from a `Headers`
 * object. Returns the decoded `clientId` on success, `null` on any failure
 * (missing, expired, bad sig). Used by the `databaseHooks.user.create.before`
 * guard, which is invoked from Better Auth's internal context and only has
 * access to the request headers (not a Hono context).
 */
export function readPendingClientCookieFromHeaders(headers: Headers | null): string | null {
  if (!headers) return null;
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return null;
  const raw = parseCookieHeader(cookieHeader, COOKIE_NAME);
  return raw ? parseAndVerify(raw) : null;
}

/** Remove the cookie. Called after a successful login/register POST. */
export function clearPendingClientCookie(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

/** Mark of headers minted by `headersWithAuthoritativePendingClient`: a per-process secret. */
export const AUTHORITATIVE_PENDING_CLIENT_HEADER = "x-appstrate-pending-client-authority";
const AUTHORITY_PROOF = crypto.randomUUID();

export function hasAuthoritativePendingClient(headers: Headers | null): boolean {
  return headers?.get(AUTHORITATIVE_PENDING_CLIENT_HEADER) === AUTHORITY_PROOF;
}

/**
 * Build the signed cookie value — the exact string
 * `issuePendingClientCookie` writes to `Set-Cookie`. Exposed so the
 * server-driven OIDC handlers can mint an AUTHORITATIVE binding to feed into a
 * Better-Auth call (see `headersWithAuthoritativePendingClient`) instead of
 * trusting the browser-supplied cookie.
 */
function buildSignedPendingClientValue(clientId: string): string {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  return signKeyringToken(PENDING_CLIENT_TOKEN_DOMAIN, { clientId, exp }, authKeyring());
}

/**
 * Return a clone of `source` whose `Cookie` header carries an authoritative
 * `oidc_pending_client` binding for `clientId`, replacing any value the browser
 * sent.
 *
 * WHY (CRIT-15): on the server-driven signup paths (`POST /api/oauth/register`,
 * magic-link request) the platform calls Better Auth in-process and forwards
 * `c.req.raw.headers`. The realm resolver + signup guard then read the pending
 * client from THOSE headers. If they read the raw browser cookie, the caller —
 * who fully controls their own request — can simply STRIP or overwrite the
 * cookie (or race a second tab that clobbers the single global cookie) so the
 * resolver sees "no pending client" and mints a full `platform`-realm user for
 * what is really a space (`end_user:<spaceId>`) flow. That user then
 * passes `requirePlatformRealm` on every platform route.
 *
 * By re-deriving the binding from the `client_id` that was already validated
 * out of the OAuth `authorize` query (`ctx.client`), the realm is pinned to the
 * transaction the server actually authorized, not to an ambient, forgeable
 * cookie. All other cookies on the request (the BA session, CSRF, …) are
 * preserved untouched.
 *
 * The value is percent-encoded to match what a browser round-trips through
 * `Set-Cookie` → `Cookie`, so the out-of-band reader (`parseCookieHeader`,
 * which `decodeURIComponent`s) recovers the identical signed string.
 */
export function headersWithAuthoritativePendingClient(source: Headers, clientId: string): Headers {
  const headers = new Headers(source);
  headers.set(AUTHORITATIVE_PENDING_CLIENT_HEADER, AUTHORITY_PROOF);
  const encoded = encodeURIComponent(buildSignedPendingClientValue(clientId));
  const existing = headers.get("cookie");
  const others = existing
    ? existing
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !p.startsWith(`${COOKIE_NAME}=`))
    : [];
  others.push(`${COOKIE_NAME}=${encoded}`);
  headers.set("cookie", others.join("; "));
  return headers;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function parseAndVerify(raw: string): string | null {
  const payload = verifyKeyringToken<{ clientId?: unknown; exp?: unknown }>(
    PENDING_CLIENT_TOKEN_DOMAIN,
    raw,
    authKeyring(),
  );
  if (typeof payload?.clientId !== "string" || typeof payload.exp !== "number") return null;
  return payload.exp < Math.floor(Date.now() / 1000) ? null : payload.clientId;
}

/**
 * Minimal cookie-header parser — we can't pull in a heavy dep just to read
 * one cookie out of band. Matches `name=value; name2=value2` format,
 * respects spaces and quoted values (RFC 6265 §5.4). The value is
 * URL-decoded to mirror what hono's `getCookie` does on the context path —
 * Set-Cookie serialization runs every value through `encodeURIComponent`.
 */
function parseCookieHeader(header: string, name: string): string | null {
  const target = `${name}=`;
  for (const rawPair of header.split(";")) {
    const pair = rawPair.trim();
    if (pair.startsWith(target)) {
      let value = pair.slice(target.length);
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}
