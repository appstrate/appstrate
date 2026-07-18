// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted-connect-portal session plumbing (issue #769).
 *
 * Centralizes the connect-session token lifecycle so the route layer stays
 * thin:
 *  - mint the initial capability token + build the agent-facing `connect_url`
 *  - single-use consumption of the token's `jti` (atomic SET-NX on the KV cache)
 *  - the page-cookie variant (httpOnly, SameSite=Strict) that carries context
 *    across the standalone hosted form, plus its double-submit CSRF nonce
 *  - reconstruct `AppScope` / `Actor` from token claims (no request auth)
 *
 * The token is the ONLY context source for the unauthenticated hosted surface;
 * the credential secret never rides the token or the query string.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  mintConnectSession,
  verifyConnectSession,
  type ConnectSessionClaims,
} from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { getCache } from "../../infra/index.ts";
import type { AppEnv } from "../../types/index.ts";
import type { AppScope } from "../../lib/scope.ts";
import type { Actor } from "../../lib/actor.ts";

/** Cookie carrying the page-scoped session token across the hosted form. */
export const CONNECT_PAGE_COOKIE = "appstrate_connect";
/** Path the page cookie is scoped to — the hosted connect endpoints only. */
const CONNECT_COOKIE_PATH = "/api/integrations/connect";
/** Header the hosted form echoes the CSRF nonce back in on submit. */
export const CONNECT_CSRF_HEADER = "x-connect-csrf";

const JTI_PREFIX = "connect-jti:";

/**
 * Resolve the connect-session signing keyring. `CONNECT_SESSION_SECRET` is a
 * required env var (boot fails without it — issue #905), so the hosted connect
 * surface is always available once the platform is up.
 */
export function connectSessionSecret(): string {
  return getEnv().CONNECT_SESSION_SECRET;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function newId(): string {
  return randomBytes(16).toString("base64url");
}

/** Claims needed to mint a capability token — `jti`/`exp` are filled in here. */
export type ConnectSessionInput = Omit<ConnectSessionClaims, "jti" | "exp" | "v" | "csrf">;

/**
 * Mint the initial capability token and build the agent-facing connect URL.
 * Returns the URL + absolute expiry (ms) for the API response.
 */
export function buildConnectUrl(input: ConnectSessionInput): {
  connectUrl: string;
  expiresAt: number;
} {
  const ttlMs = getEnv().CONNECT_SESSION_TTL_MS;
  const expSeconds = nowSeconds() + Math.floor(ttlMs / 1000);
  const claims: ConnectSessionClaims = {
    v: 1,
    ...input,
    jti: newId(),
    exp: expSeconds,
  };
  const token = mintConnectSession(claims, connectSessionSecret());
  const base = getEnv().APP_URL.replace(/\/$/, "");
  const connectUrl = `${base}/api/integrations/connect/start?token=${encodeURIComponent(token)}`;
  return { connectUrl, expiresAt: expSeconds * 1000 };
}

/** Verify a capability/page token. Returns claims or null. */
export function readConnectToken(token: string): ConnectSessionClaims | null {
  return verifyConnectSession(token, connectSessionSecret());
}

/**
 * Atomically consume a token's `jti` — single-use replay guard. Returns true on
 * the first consumption, false if the jti was already consumed (replay) or the
 * token has already expired. Uses SET-NX so a Redis-backed deployment is
 * race-free; the in-memory fallback is best-effort (single instance anyway).
 */
export async function consumeJti(jti: string, expSeconds: number): Promise<boolean> {
  const ttlSeconds = Math.max(1, expSeconds - nowSeconds());
  const cache = await getCache();
  return cache.set(JTI_PREFIX + jti, "1", { nx: true, ttlSeconds });
}

/**
 * After the capability token is consumed, mint a fresh page-cookie token
 * (new jti, CSRF nonce, same context) and set it as an httpOnly, SameSite=Strict
 * cookie scoped to the hosted connect path. Returns the CSRF nonce for the page
 * to read via the context endpoint.
 *
 * SameSite=Strict is safe here because every post-dispatch hop is same-site to
 * us: `/connect/start` (which sets this cookie) redirects to `/connect`, whose
 * fetches to `/connect/context` + `/connect/submit` are same-origin, so the
 * cookie is always sent. The only cross-site hop is the initial popup open,
 * which SETS (never reads) the cookie.
 *
 * Known EMBEDDED caveat (non-oauth, cross-origin opener): the cookie is written
 * during a cross-site→same-site redirect chain, which Safari's bounce-tracking
 * protection / ITP may classify as tracking and purge — breaking the hosted
 * form for embedded end-users on Safari. This is inherent to the popup model
 * (Nango hits the same wall); first-party (same-origin opener) flows are
 * unaffected. Revisit with a partitioned/storage-access approach if embedded
 * Safari support becomes a requirement.
 */
export function setConnectPageCookie(c: Context<AppEnv>, claims: ConnectSessionClaims): string {
  const csrf = newId();
  const ttlMs = getEnv().CONNECT_SESSION_TTL_MS;
  const expSeconds = nowSeconds() + Math.floor(ttlMs / 1000);
  const pageClaims: ConnectSessionClaims = {
    ...claims,
    jti: newId(),
    csrf,
    exp: expSeconds,
  };
  const token = mintConnectSession(pageClaims, connectSessionSecret());
  const secure = getEnv().APP_URL.startsWith("https://");
  setCookie(c, CONNECT_PAGE_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: CONNECT_COOKIE_PATH,
    maxAge: Math.floor(ttlMs / 1000),
  });
  return csrf;
}

/** Read + verify the page-cookie token. Returns claims or null. */
export function readConnectPageCookie(c: Context<AppEnv>): ConnectSessionClaims | null {
  const token = getCookie(c, CONNECT_PAGE_COOKIE);
  if (!token) return null;
  return readConnectToken(token);
}

/** Clear the page cookie (after a successful submit). */
export function clearConnectPageCookie(c: Context<AppEnv>): void {
  deleteCookie(c, CONNECT_PAGE_COOKIE, { path: CONNECT_COOKIE_PATH });
}

/**
 * Constant-time double-submit CSRF check. Returns true only when the page
 * cookie carries a nonce AND the header echoes it back byte-for-byte. Compared
 * in constant time so a mismatch can't be timed out character by character.
 */
export function csrfMatches(claims: ConnectSessionClaims, header: string | undefined): boolean {
  if (!claims.csrf || !header) return false;
  const a = Buffer.from(claims.csrf);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build an `AppScope` from token claims. */
export function scopeFromClaims(claims: ConnectSessionClaims): AppScope {
  return { orgId: claims.org_id, applicationId: claims.application_id };
}

/** Build an `Actor` from token claims (exactly one of user/end-user is set). */
export function actorFromClaims(claims: ConnectSessionClaims): Actor {
  if (claims.end_user_id) return { type: "end_user", id: claims.end_user_id };
  return { type: "user", id: claims.user_id! };
}
