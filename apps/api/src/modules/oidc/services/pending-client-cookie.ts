// SPDX-License-Identifier: Apache-2.0

/**
 * Pending-client signed cookie — plumbs the OAuth `client_id` from the
 * server-rendered entry pages (`/api/oauth/login`, `/api/oauth/register`,
 * `/api/oauth/magic-link`) through the subsequent Better Auth round-trip
 * (social callback, magic-link verify) so the `databaseHooks.user.create.before`
 * guard can apply the per-client signup policy BEFORE a brand-new Better Auth
 * user row is committed.
 *
 * Why a cookie and not AsyncLocalStorage: the social sign-in flow bounces the
 * browser off a third-party IdP (Google, GitHub) and lands on
 * `/api/auth/callback/:provider` minutes later — the original Node async
 * context is long gone. A signed cookie survives the redirect chain,
 * requires no server-side state (no Redis key), and is readable from any
 * request that carries it.
 *
 * Security:
 *   - HMAC-SHA256 signature with `BETTER_AUTH_SECRET` so a client cannot
 *     forge a `clientId`.
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

import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { getEnv } from "@appstrate/env";
import { logger } from "../../../lib/logger.ts";
import { signAuthHmac, verifyAuthHmac } from "../../../lib/auth-secrets.ts";
import type { AppEnv } from "../../../types/index.ts";

let insecureCookieWarned = false;

const COOKIE_NAME = "oidc_pending_client";
const COOKIE_MAX_AGE = 10 * 60; // 10 minutes

/**
 * Sign `clientId` + `exp` with HMAC-SHA256 and set the cookie. Safe to call
 * multiple times on the same request — the latest call wins (browsers
 * overwrite by (name, path, domain)).
 */
export function issuePendingClientCookie(c: Context<AppEnv>, clientId: string): void {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  const payload = `${clientId}.${exp}`;
  const sig = signAuthHmac(payload);
  const value = `${payload}.${sig}`;
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
 * Read + verify the cookie from a Hono context. Returns the decoded
 * `clientId` on success, `null` on any failure (missing, expired, bad sig).
 *
 * Used by OIDC routes that have a Hono context in scope (e.g. guards that
 * clear the cookie after use).
 */
export function readPendingClientCookie(c: Context<AppEnv>): string | null {
  const raw = getCookie(c, COOKIE_NAME);
  return raw ? parseAndVerify(raw) : null;
}

/**
 * Variant of `readPendingClientCookie` that reads directly from a `Headers`
 * object. Used by the `databaseHooks.user.create.before` guard, which is
 * invoked from Better Auth's internal context and only has access to the
 * request headers (not a Hono context).
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

// ─── Internals ────────────────────────────────────────────────────────────────

function parseAndVerify(raw: string): string | null {
  // Format: `<clientId>.<exp>.<sig>`. `clientId` never contains a dot (it
  // starts with `oauth_` and is base64url) and `sig` is now `<kid>$<hmac>`
  // — neither contains a dot — so splitting on `.` still yields exactly 3
  // parts. Legacy un-prefixed signatures are accepted by `verifyAuthHmac`.
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [clientId, expStr, sig] = parts as [string, string, string];
  if (!verifyAuthHmac(`${clientId}.${expStr}`, sig)) return null;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  return clientId;
}

/**
 * Minimal cookie-header parser — we can't pull in a heavy dep just to read
 * one cookie out of band. Matches `name=value; name2=value2` format,
 * respects spaces and quoted values (RFC 6265 §5.4).
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
      return value;
    }
  }
  return null;
}
