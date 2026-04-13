// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application social auth resolver.
 *
 * Given an OAuth client + a provider id (`"google"` | `"github"`), returns the
 * OAuth App credentials the OIDC flows should use for this request:
 *  - `level=application` → reads `application_social_providers` for the
 *    referenced app. If absent, returns `null` (that provider's button is
 *    hidden on the tenant's login pages). No fallback to instance env creds.
 *  - `level=org` / `level=instance` → NOT handled here. The env-based
 *    credentials baked into the BA singleton at boot (see `packages/db/src/auth.ts`)
 *    continue to apply. This resolver is a per-app lookup only, invoked by
 *    the BA override plugin and by `loadPageContext` when gating buttons for
 *    application-level clients.
 *
 * Decrypted secrets are cached in-memory keyed by `${applicationId}:${provider}`
 * with a short TTL. Null entries are cached too (shorter TTL) so a freshly-
 * configured admin sees changes quickly without hammering the DB on every
 * login page render. `invalidateSocialCache()` is called by the admin routes
 * on upsert/delete.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { decryptCredentials } from "@appstrate/connect";
import { applicationSocialProviders } from "../schema.ts";
import type { OAuthClientRecord } from "./oauth-admin.ts";
import { createTtlCache } from "./ttl-cache.ts";
import { createTestSpy } from "./test-spy.ts";
import { CURRENT_ENCRYPTION_KEY_VERSION } from "./encryption-key-version.ts";
import { logger } from "../../../lib/logger.ts";

export type SocialProviderId = "google" | "github";

/**
 * Note on the `source` asymmetry vs `ResolvedSmtpConfig`:
 * SMTP's resolver handles the env-fallback ("instance" source) itself, because
 * BA's mail-sending callbacks route through `withSmtpOverride` + env fallback
 * at the route layer. Social auth fallback to env creds is NOT handled here
 * at all — env `GOOGLE_CLIENT_ID` / `GITHUB_CLIENT_ID` flow through BA's
 * `socialProviders` getters in `packages/db/src/auth.ts`, which consult
 * `getSocialOverride()` (set by the BA before-hook) and fall through to env
 * when no per-app override exists. This resolver is therefore per-app only:
 * a `null` return means "no per-app config" and the getter layer takes over.
 */
export interface ResolvedSocialProvider {
  clientId: string;
  clientSecret: string; // decrypted
  scopes: string[] | null;
  source: "per-app";
}

const cache = createTtlCache<ResolvedSocialProvider>("oidc:social-cache-invalidate");

function cacheKey(applicationId: string, provider: SocialProviderId): string {
  return `${applicationId}:${provider}`;
}

/**
 * Test-only resolve spy. When set, every resolution (hit, miss, cached)
 * invokes the spy with the resolved source so E2E tests can assert which
 * per-app creds were looked up for a given request. Mirrors `_setSmtpSpy`
 * in `smtp-config.ts`.
 */
export interface SpiedSocialResolve {
  applicationId: string;
  provider: SocialProviderId;
  hit: boolean;
}
const socialResolveSpy = createTestSpy<SpiedSocialResolve>("_setSocialSpy");
export const _setSocialSpy = socialResolveSpy.setter;

async function resolvePerApp(
  applicationId: string,
  provider: SocialProviderId,
): Promise<ResolvedSocialProvider | null> {
  const key = cacheKey(applicationId, provider);
  const value = await cache.getOrLoad(key, async () => {
    const [row] = await db
      .select()
      .from(applicationSocialProviders)
      .where(
        and(
          eq(applicationSocialProviders.applicationId, applicationId),
          eq(applicationSocialProviders.provider, provider),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.encryptionKeyVersion !== CURRENT_ENCRYPTION_KEY_VERSION) {
      logger.warn("oidc social: stale encryption key version, treating as unconfigured", {
        applicationId,
        provider,
        rowVersion: row.encryptionKeyVersion,
        currentVersion: CURRENT_ENCRYPTION_KEY_VERSION,
      });
      return null;
    }
    const decrypted = decryptCredentials<{ clientSecret: string }>(row.clientSecretEncrypted);
    return {
      clientId: row.clientId,
      clientSecret: decrypted.clientSecret,
      scopes: row.scopes,
      source: "per-app",
    };
  });
  socialResolveSpy.emit({ applicationId, provider, hit: value !== null });
  return value;
}

/**
 * Resolve per-app OAuth credentials for an application-level OAuth client.
 * Returns `null` for non-application clients or when no row exists — callers
 * gate the social button accordingly (`features.socialGoogle = !!result`).
 */
export async function resolveSocialProviderForClient(
  client: Pick<OAuthClientRecord, "level" | "referencedApplicationId">,
  provider: SocialProviderId,
): Promise<ResolvedSocialProvider | null> {
  if (client.level !== "application") return null;
  if (!client.referencedApplicationId) return null;
  return resolvePerApp(client.referencedApplicationId, provider);
}

/**
 * Invalidate cached entries for an application. If `provider` is provided,
 * only that provider's entry is cleared; otherwise both are cleared.
 */
export async function invalidateSocialCache(
  applicationId: string,
  provider?: SocialProviderId,
): Promise<void> {
  if (provider) {
    await cache.delete(cacheKey(applicationId, provider));
    return;
  }
  await Promise.all([
    cache.delete(cacheKey(applicationId, "google")),
    cache.delete(cacheKey(applicationId, "github")),
  ]);
}

/** Test-only: clear the entire cache. */
export function _clearSocialCacheForTesting(): void {
  cache.clearForTesting();
}
