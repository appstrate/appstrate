// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugin — inject per-app social OAuth credentials into the
 * Google/GitHub provider configs on `level=application` flows.
 *
 * The `socialProviders` block in `packages/db/src/auth.ts` exposes `clientId`
 * and `clientSecret` as getters that first consult an AsyncLocalStorage
 * override (`getSocialOverride()`). This plugin is where that override gets
 * set: a `before` hook matching BA's social sign-in + callback endpoints
 * reads the pending-client cookie, resolves per-app creds, and calls
 * `enterSocialOverride()`. Every downstream BA method that touches
 * `options.clientId` / `options.clientSecret` (verified lazy-read across
 * `@better-auth/core/social-providers/{google,github}.mjs`, `oauth2/*.mjs`
 * in version 1.6.2) then sees the tenant's creds instead of the env's.
 *
 * Matchers:
 *  - `/sign-in/social` — outbound leg (redirect to Google/GitHub)
 *  - `/callback/:provider` — return leg (token exchange + profile fetch)
 *  - `/oauth2-callback/:provider` — alternative BA callback path
 *
 * No-op when the pending-client cookie is missing, the referenced client is
 * not `level=application`, or no per-app creds are configured. In that last
 * case the getters fall through to env — which, for an app-level client
 * that hasn't configured the provider, will be empty. The provider factory's
 * own `CLIENT_ID_AND_SECRET_REQUIRED` guard then rejects the request — but
 * that path should never execute because the login page's feature-flag
 * gating (`features.socialGoogle` / `features.socialGithub`) prevents the
 * button from being rendered in the first place.
 */

import { createAuthMiddleware } from "better-auth/api";
import { enterSocialOverride, type SocialOverride } from "@appstrate/db/auth";
import { logger } from "../../../lib/logger.ts";
import { getClientCached } from "./oauth-admin.ts";
import { readPendingClientCookieFromHeaders } from "./pending-client-cookie.ts";
import { resolveSocialProviderForClient } from "./social-config.ts";

async function applyOverride(ctx: { request?: Request }): Promise<void> {
  const pendingClientId = readPendingClientCookieFromHeaders(ctx.request?.headers ?? null);
  if (!pendingClientId) return;

  const client = await getClientCached(pendingClientId);
  if (!client || client.level !== "application" || !client.referencedApplicationId) return;

  try {
    const [google, github] = await Promise.all([
      resolveSocialProviderForClient(client, "google"),
      resolveSocialProviderForClient(client, "github"),
    ]);
    const override: SocialOverride = {};
    if (google) {
      override.google = { clientId: google.clientId, clientSecret: google.clientSecret };
    }
    if (github) {
      override.github = { clientId: github.clientId, clientSecret: github.clientSecret };
    }
    if (Object.keys(override).length > 0) {
      enterSocialOverride(override);
    }
  } catch (err) {
    // A resolver failure (DB blip, decryption error, …) must not leak the
    // platform's env creds to a tenant's flow — safer to fail closed. Log
    // and let the downstream BA provider surface its own
    // `CLIENT_ID_AND_SECRET_REQUIRED` error.
    // Resolver failure is expected during key rotation (stale rows return null
    // upstream but a decryption throw surfaces here). Log as `warn` for parity
    // with `smtp-config.ts` — the downstream BA provider will surface a proper
    // `CLIENT_ID_AND_SECRET_REQUIRED` if this was not a transient blip.
    logger.warn("oidc: failed to resolve per-app social credentials", {
      module: "oidc",
      clientId: pendingClientId,
      applicationId: client.referencedApplicationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function matchesSocialPath(path?: string): boolean {
  if (!path) return false;
  return (
    path === "/sign-in/social" ||
    path.startsWith("/callback/") ||
    path.startsWith("/oauth2-callback/")
  );
}

/**
 * Build the social override plugin. Returned shape mirrors the pattern used
 * by `oidcGuardsPlugin` — a minimal `{ id, hooks.before }` object, no
 * dependency on `@better-auth/core` types at this layer.
 */
export function socialOverridePlugin() {
  return {
    id: "oidc-social-override",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => matchesSocialPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            await applyOverride(ctx as { request?: Request });
          }),
        },
      ],
    },
  };
}
