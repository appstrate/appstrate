// SPDX-License-Identifier: Apache-2.0

/**
 * CSRF protection for OIDC end-user forms.
 *
 * Double-submit cookie pattern: the GET handler generates a cryptographically
 * random token, sends it back as a hidden form field AND as an httpOnly
 * `SameSite=Lax` cookie. The POST handler compares the two — mismatch → 403.
 *
 * We deliberately keep this in-module rather than using a generic CSRF
 * middleware because the OIDC flows are the first end-user-facing forms on
 * the platform; every other route is API-key or session authenticated and
 * has no form surface.
 */

import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../../../types/index.ts";

const COOKIE_NAME = "oidc_csrf";
const COOKIE_MAX_AGE = 10 * 60; // 10 minutes — long enough for login, short enough to rotate

/**
 * Generate a new CSRF token, set the paired cookie on the response, and
 * return the token string to embed in the form body.
 *
 * The `secure` flag is derived from `APP_URL` scheme — browsers silently
 * drop `Secure` cookies over HTTP, which would break Tier 0 dev mode
 * (`http://localhost:3000`). In HTTPS deployments the flag is set.
 */
export function issueCsrfToken(c: Context<AppEnv>): string {
  const token = generateToken();
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: getEnv().APP_URL.startsWith("https://"),
    path: "/api/oauth/enduser",
    maxAge: COOKIE_MAX_AGE,
  });
  return token;
}

/**
 * Read the CSRF cookie + compare it to the token submitted in the form body.
 * Returns `true` on match, `false` on any mismatch (including missing
 * cookie or missing body field). On match, the cookie is rotated — a given
 * token is good for exactly one POST.
 */
export function verifyCsrfToken(c: Context<AppEnv>, bodyToken: string | undefined): boolean {
  const cookieToken = getCookie(c, COOKIE_NAME);
  if (!cookieToken || !bodyToken) return false;
  if (!constantTimeEqual(cookieToken, bodyToken)) return false;
  // One-shot: rotate by deleting so replays fail.
  deleteCookie(c, COOKIE_NAME, { path: "/api/oauth/enduser" });
  return true;
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Length-safe string comparison that short-circuits on length mismatch
 * but runs in constant time for equal-length inputs.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
