// SPDX-License-Identifier: Apache-2.0

/**
 * Helper for clearing stale Better Auth session cookies.
 *
 * When `getAuth().api.getSession(...)` returns no user even though the request
 * carries a Better Auth session cookie (signature invalid after secret
 * rotation, session row gone after a DB migration / redeployment, etc.) the
 * cookie is dead weight: every subsequent request keeps sending it, the
 * server keeps rejecting it, and the SPA bounces back to `/login` in a silent
 * loop because the browser never lets go of the bad cookie on its own.
 *
 * The fix is to mirror BA's own cookie config (name, Path, Domain, Secure,
 * SameSite, Partitioned) on a `Set-Cookie: …; Max-Age=0` so the browser
 * actually forgets the cookie. Going through `getCookies(auth.options)` is
 * load-bearing — the computed name carries the `__Secure-` prefix when BA
 * decided one was warranted, and the attributes pick up our project-wide
 * `defaultCookieAttributes` (`partitioned: true`, plus the optional
 * `crossSubDomainCookies` Domain). A hand-rolled `Set-Cookie` that misses
 * any of those attributes is silently ignored by the browser.
 */

import type { Context } from "hono";
import { deleteCookie } from "hono/cookie";
import { getCookies } from "better-auth/cookies";
import { getAuth } from "@appstrate/db/auth";
import type { AppEnv } from "../types/index.ts";

/**
 * Send `Set-Cookie: …; Max-Age=0` for every Better Auth cookie we manage so
 * a stale session_token / session_data / dont_remember / account_data does
 * not keep re-arriving on subsequent requests. Safe to call when no cookie
 * is present — the browser ignores deletes for cookies it does not have.
 *
 * Call before throwing 401 from the auth pipeline. Do NOT call from the
 * realm guard: an end-user session that lands on a platform route is still
 * a legitimate session for the OIDC application it was minted for, and
 * killing the cookie would log the user out from that application too.
 */
export function clearStaleAuthCookies(c: Context<AppEnv>): void {
  const cookies = getCookies(getAuth().options);
  for (const cookie of [
    cookies.sessionToken,
    cookies.sessionData,
    cookies.dontRememberToken,
    cookies.accountData,
  ]) {
    // `attributes` already carries Path, Domain (when crossSubDomainCookies
    // is on), SameSite, Secure, HttpOnly and Partitioned exactly as BA
    // emitted them at Set-Cookie time. `deleteCookie` overlays `maxAge: 0`,
    // which is what flips this from a refresh into a delete.
    deleteCookie(c, cookie.name, cookie.attributes);
  }
}
