// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for Better Auth session cookies on server-side session reads.
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
import { eq } from "drizzle-orm";
import { getAuth } from "@appstrate/db/auth";
import { parseBearer } from "@appstrate/core/bearer";
import { propagateRequestClientIp } from "./client-ip.ts";
import { db } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";

/**
 * A request presenting `Authorization: Bearer …` is judged by that bearer
 * alone: its Cookie header is withheld from Better Auth and nothing it reads
 * writes the browser's cookie jar. Better Auth's `bearer()` plugin (oidc
 * module) signs a dotless bearer itself and substitutes it for the session
 * cookie, so a forged one (`Bearer undefined`, from any script on the page)
 * resolves to no session and Better Auth answers with a delete of the cookie
 * the browser holds, a credential the request was never judged on.
 */
function bearerOnly(headers: Headers): Headers | null {
  if (parseBearer(headers.get("Authorization")) === null) return null;
  const stripped = new Headers(headers);
  stripped.delete("Cookie");
  return stripped;
}

/** Every session read outside Better Auth's handler. A cookie read forwards Better Auth's Set-Cookie (sliding refresh). */
export async function readSessionWithCookies(c: Context) {
  const stripped = bearerOnly(c.req.raw.headers);
  const { headers, response } = await getAuth().api.getSession({
    headers: stripped ?? c.req.raw.headers,
    returnHeaders: true,
  });
  const viaBearer = stripped !== null;
  return { session: response, setCookies: viaBearer ? [] : headers.getSetCookie(), viaBearer };
}

/**
 * Better Auth's handler (`/api/auth/*`), whose endpoints read the session
 * themselves, under the same rule: the Set-Cookie writes of the managed cookies
 * are dropped from a bearer request's answer. A bearer client reads a minted
 * session from `set-auth-token`, which the `bearer()` plugin still sets.
 */
export async function handleAuthRequest(req: Request): Promise<Response> {
  const stripped = bearerOnly(req.headers);
  if (!stripped) return getAuth().handler(req);
  const forwarded = new Request(req, { headers: stripped });
  propagateRequestClientIp(req, forwarded);
  const res = await getAuth().handler(forwarded);
  const managed = new Set(managedAuthCookies().map((cookie) => cookie.name));
  const setCookies = res.headers.getSetCookie();
  if (!setCookies.some((cookie) => managed.has(cookieNameOf(cookie)))) return res;
  const headers = new Headers(res.headers);
  headers.delete("Set-Cookie");
  for (const cookie of setCookies) {
    if (!managed.has(cookieNameOf(cookie))) headers.append("Set-Cookie", cookie);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function cookieNameOf(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf("=")).trim();
}

/** The Better Auth cookies the platform manages, as Better Auth computes them. */
function managedAuthCookies() {
  const cookies = getCookies(getAuth().options);
  return [
    cookies.sessionToken,
    cookies.sessionData,
    cookies.dontRememberToken,
    cookies.accountData,
  ];
}

/** Appended, never set: other cookies on the response survive. */
export function appendSetCookies(c: Context, setCookies: readonly string[]): void {
  for (const cookie of setCookies) c.header("Set-Cookie", cookie, { append: true });
}

/** For handlers: forwards the cookies onto the response they are about to build. */
export async function getSessionForwardingCookies(c: Context) {
  const { session, setCookies } = await readSessionWithCookies(c);
  appendSetCookies(c, setCookies);
  return session;
}

/**
 * The realm of a cookie session's account: the value denormalized onto the session row at
 * creation (`databaseHooks.session.create.before`, `packages/db/src/auth.ts`), else the user
 * row's. `undefined` when neither exists. Every reader of a cookie session that grants platform
 * access asks this: the auth pipeline for `requirePlatformRealm`, and the routes that read the
 * session outside it.
 */
export async function sessionRealmOf(session: {
  session: object;
  user: { id: string };
}): Promise<string | undefined> {
  const onSession = (session.session as { realm?: unknown }).realm;
  if (typeof onSession === "string") return onSession;
  const [row] = await db
    .select({ realm: userTable.realm })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);
  return row?.realm;
}

/**
 * Send `Set-Cookie: …; Max-Age=0` for every Better Auth cookie we manage so
 * a stale session_token / session_data / dont_remember / account_data does
 * not keep re-arriving on subsequent requests. Safe to call when no cookie
 * is present — the browser ignores deletes for cookies it does not have.
 *
 * Call before throwing 401 from the auth pipeline. Do NOT call from the
 * realm guard: an end-user session that lands on a platform route is still
 * a legitimate session for the end-user space it was minted for, and
 * killing the cookie would log the user out from that space too.
 *
 * Two complementary mechanisms run together — not a primary + legacy split,
 * defense in depth with different trade-offs:
 *
 *   1. Targeted `Set-Cookie: Max-Age=0` (below): primary path for the 99%
 *      case where the cookie was issued by the same instance config that
 *      is now serving the request. Surgical (kills only the 4 BA cookies),
 *      works on plain HTTP, works on legacy browsers.
 *
 *   2. `Clear-Site-Data: "cookies"`: backstop for config drift. When the
 *      cookie was issued under a *previous* `COOKIE_DOMAIN` (e.g. set then
 *      unset between deployments) or a different cookie-name prefix, RFC
 *      6265 silently rejects the targeted delete because the `Domain`
 *      attribute does not match. `Clear-Site-Data` purges every cookie
 *      visible to the origin without needing `Domain` / `Path` to match —
 *      precisely the property the targeted delete cannot offer when the
 *      issuer config has drifted. Requires HTTPS or localhost (secure
 *      context); ignored on plain HTTP, hence (1) remains as fallback.
 *      Browser support: Chrome/Edge 61+, Firefox 63+, Safari 16.4+.
 */
export function clearStaleAuthCookies(c: Context<AppEnv>): void {
  for (const cookie of managedAuthCookies()) {
    // `attributes` already carries Path, Domain (when crossSubDomainCookies
    // is on), SameSite, Secure, HttpOnly and Partitioned exactly as BA
    // emitted them at Set-Cookie time. `deleteCookie` overlays `maxAge: 0`,
    // which is what flips this from a refresh into a delete.
    deleteCookie(c, cookie.name, cookie.attributes);
  }
  // Backstop for config drift (rotated `BETTER_AUTH_SECRET`, toggled
  // `COOKIE_DOMAIN`, changed cookie-name prefix). Same-origin only,
  // honored on HTTPS / localhost. See header docstring above.
  c.header("Clear-Site-Data", '"cookies"');
}
