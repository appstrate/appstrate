// SPDX-License-Identifier: Apache-2.0

/**
 * Login-notice signed cookie — the UX notice + anti-loop marker for the
 * login-link-expiry "restart-in-place" flow.
 *
 * ROLE: when a Better Auth-signed login link reaches `/api/oauth/login` after
 * its `exp` has passed, the handler cannot render the (now useless) form. It
 * instead sets THIS cookie and bounces the browser through
 * `/api/auth/oauth2/authorize` to mint a fresh link. The fresh login page then
 * reads + clears the cookie to:
 *   1. show an error banner ("link expired, please sign in again"), and
 *   2. optionally prefill the email the expired link carried, and
 *   3. act as an anti-redirect-loop marker — but PER OAUTH TRANSACTION, keyed
 *      to the `state` param. A genuine loop replays the SAME `state` (the SPA
 *      mints a unique state per login), so the loop guard only fires when an
 *      expired login page sees a notice cookie whose `state` matches the
 *      request's. This avoids a false trip when two independent tabs are each
 *      on an expired link: tab B's distinct `state` (or absent state) is a
 *      different transaction, so it restarts normally instead of dead-ending.
 *
 * Why a cookie and not a query param: Better Auth's `authorize` endpoint
 * re-serializes its query string through a Zod whitelist and DROPS any
 * unknown params, so a `?notice=…` marker cannot survive the
 * authorize → loginPage round-trip. A cookie rides alongside the redirect
 * chain untouched.
 *
 * The cookie carries NO authority: it is purely display state + a loop guard.
 * Forging it at worst shows a banner (and suppresses one restart bounce) — it
 * grants no access, pins no realm, and is never trusted for any security
 * decision. We still HMAC-sign it (with `BETTER_AUTH_SECRET`) so a malformed /
 * tampered value is cleanly rejected rather than parsed, but unlike the
 * pending-client cookie there is nothing to protect, so we skip the
 * production insecure-`Secure`-flag warning: an unencrypted notice cookie
 * leaks nothing worth warning about.
 *
 * The email is embedded in the payload, which (because emails contain dots)
 * we serialize as JSON and base64url-encode BEFORE signing. The cookie value
 * is `<base64urlPayload>.<exp>.<sig>` — base64url and the `<kid>$<hmac>` sig
 * contain no dots, so splitting on `.` still yields exactly 3 parts (same
 * 3-part shape as `pending-client-cookie.ts`).
 *
 * Scoped to `Path=/api/oauth` — the only routes that issue and read it.
 */

import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";
import { getEnv } from "@appstrate/env";
import { signAuthHmac, verifyAuthHmac } from "../../../lib/auth-secrets.ts";
import type { AppEnv } from "../../../types/index.ts";

const COOKIE_NAME = "oidc_login_notice";
const COOKIE_PATH = "/api/oauth";
const COOKIE_MAX_AGE = 60; // 60 seconds — the authorize→login round-trip is
// sub-second; 60s absorbs slow redirects without leaving a stale banner.

/**
 * The known, closed set of notice payloads this cookie can carry.
 *
 * `state` is the OAuth `state` of the transaction that bounced — the loop
 * guard compares it against the restarted request's `state` so only a genuine
 * same-transaction loop (not two independent tabs) trips the terminal page.
 */
export type LoginNotice = { code: "login_link_expired"; email?: string; state?: string };

/**
 * Max stored length of `state`. It exists solely as a loop discriminator, so a
 * generous cap suffices; an over-long value (never produced by our SPA) is
 * dropped rather than stored (see `buildSignedLoginNoticeValue`).
 */
const MAX_STATE_LENGTH = 256;

/**
 * Max stored length of `email` — RFC 5321's 254-octet address ceiling. The
 * email is a prefill convenience only; an over-long value (hostile or typo'd
 * form input) is dropped rather than allowed to bloat the signed cookie past
 * the ~4KB browser limit, where the whole cookie would be silently discarded.
 */
const MAX_EMAIL_LENGTH = 254;

/**
 * Serialize + sign `notice` and set the cookie. Safe to call multiple times on
 * the same request — the latest call wins (browsers overwrite by
 * (name, path, domain)).
 */
export function issueLoginNoticeCookie(c: Context<AppEnv>, notice: LoginNotice): void {
  const value = buildSignedLoginNoticeValue(notice);
  const secure = getEnv().APP_URL.startsWith("https://");
  setCookie(c, COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE,
  });
}

/**
 * Read + verify the notice cookie, then DELETE it — one-shot semantics. Any
 * PRESENT cookie is cleared regardless of validity: a garbage or tampered
 * value must not linger and re-trigger the banner on the next render. When no
 * cookie is present, no clearing header is emitted — this keeps the common
 * login render free of `Set-Cookie` noise and, on the restart bounce, avoids
 * stacking a delete + set of the same cookie in one response. Returns the
 * decoded notice on success, `null` on any failure (missing, expired, bad
 * sig, malformed payload).
 */
export function readAndClearLoginNoticeCookie(c: Context<AppEnv>): LoginNotice | null {
  const raw = getCookie(c, COOKIE_NAME);
  if (raw === undefined) return null;
  deleteCookie(c, COOKIE_NAME, { path: COOKIE_PATH });
  return parseAndVerify(raw);
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Build the signed cookie value: `<base64urlPayload>.<exp>.<sig>` where
 * `sig = signAuthHmac(`${base64urlPayload}.${exp}`)`. Exported for unit tests
 * that need to construct raw values (e.g. an expired `exp`).
 */
export function buildSignedLoginNoticeValue(notice: LoginNotice): string {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  // Cookie-size guard: drop an abnormally long `state` rather than store it.
  // Losing it only degrades the loop guard to the pre-`state` behavior (first
  // expired GET carrying a notice cookie is treated as a loop) — still safe,
  // just slightly less tab-friendly for the pathological input.
  const state =
    notice.state !== undefined && notice.state.length <= MAX_STATE_LENGTH
      ? notice.state
      : undefined;
  const email =
    notice.email !== undefined && notice.email.length <= MAX_EMAIL_LENGTH
      ? notice.email
      : undefined;
  const json = JSON.stringify({
    code: notice.code,
    ...(email !== undefined ? { email } : {}),
    ...(state !== undefined ? { state } : {}),
  });
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const signed = `${encoded}.${exp}`;
  const sig = signAuthHmac(signed);
  return `${signed}.${sig}`;
}

function parseAndVerify(raw: string): LoginNotice | null {
  // Format: `<base64urlPayload>.<exp>.<sig>`. base64url contains no dot and
  // the `<kid>$<hmac>` sig contains no dot, so a well-formed value splits into
  // exactly 3 parts.
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [encoded, expStr, sig] = parts as [string, string, string];
  if (!verifyAuthHmac(`${encoded}.${expStr}`, sig)) return null;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  // Defensive decode + parse — a bad payload yields null, never a throw.
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  return narrowNotice(parsed);
}

/**
 * Validate the parsed shape without a raw `as` cast on untrusted data. `code`
 * must be the known literal; `email` and `state`, if present, must be strings.
 */
function narrowNotice(value: unknown): LoginNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.code !== "login_link_expired") return null;
  if (obj.email !== undefined && typeof obj.email !== "string") return null;
  if (obj.state !== undefined && typeof obj.state !== "string") return null;
  const notice: LoginNotice = { code: "login_link_expired" };
  if (obj.email !== undefined) notice.email = obj.email;
  if (obj.state !== undefined) notice.state = obj.state;
  return notice;
}
