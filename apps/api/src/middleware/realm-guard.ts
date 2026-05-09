// SPDX-License-Identifier: Apache-2.0

/**
 * Platform realm guard.
 *
 * The Better Auth `user` table is shared across audiences — platform
 * operators (dashboard signup, org invitations, instance/org-level OIDC
 * clients) AND end-users of third-party applications using Appstrate as
 * their OIDC IdP. Without the realm column + this guard, a BA cookie
 * session minted via the OIDC end-user flow for application A would also
 * grant access to the Appstrate platform itself (`/api/apps`, `/api/runs`,
 * etc.) because the session row is indistinguishable from a platform
 * session at the middleware layer.
 *
 * This guard runs after the auth pipeline has resolved a BA cookie session
 * and placed its `realm` on `c.sessionRealm`. If the realm is anything
 * other than `"platform"`, the request is rejected with 403 unless it
 * targets an audience-agnostic surface:
 *
 *   - `/api/oauth/*`  — OIDC entry pages + admin endpoints; end-user
 *     sessions legitimately hit login/consent/magic-link here.
 *   - `/api/auth/*`   — Better Auth endpoints (sign-out, email change,
 *     magic-link verify) — the user must be able to manage their BA
 *     identity regardless of realm.
 *
 * Non-session auth methods (Bearer API key, OIDC JWT via auth strategies)
 * are untouched: API keys carry their own `applicationId` scope and JWTs
 * set `endUser` context explicitly, so realm enforcement there is
 * redundant. Only cookie sessions need this protection.
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { forbidden } from "../lib/errors.ts";

/**
 * Paths where a non-platform BA cookie session is legitimately allowed —
 * OIDC entry surfaces (the end-user is logging in / consenting) and BA's
 * own endpoints (sign-out, email change, etc.).
 */
function isRealmAgnosticPath(path: string): boolean {
  if (path.startsWith("/api/oauth/")) return true;
  if (path.startsWith("/api/auth/")) return true;
  return false;
}

export function requirePlatformRealm() {
  return async (c: Context<AppEnv>, next: Next) => {
    // Only cookie-session auth needs the guard. API keys and module auth
    // strategies have their own scope enforcement (applicationId,
    // endUser) and don't read/set `sessionRealm`.
    if (c.get("authMethod") !== "session") return next();

    const realm = c.get("sessionRealm");
    if (realm === "platform") return next();

    if (isRealmAgnosticPath(c.req.path)) return next();

    throw forbidden(
      "This session is not permitted to access platform routes. Sign in with a platform account.",
    );
  };
}
