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

export type SocialProviderId = "google" | "github";

export interface ResolvedSocialProvider {
  clientId: string;
  clientSecret: string; // decrypted
  scopes: string[] | null;
  source: "per-app";
}

interface CacheEntry {
  value: ResolvedSocialProvider | null;
  expiresAt: number;
}

const PER_APP_TTL_MS = 60_000;
const NULL_TTL_MS = 30_000;

const cache = new Map<string, CacheEntry>();

function cacheKey(applicationId: string, provider: SocialProviderId): string {
  return `${applicationId}:${provider}`;
}

/**
 * Test-only resolve spy. When set, every resolution (hit, miss, cached)
 * invokes the spy with the resolved source so E2E tests can assert which
 * per-app creds were looked up for a given request. Mirrors `_setTestMailSpy`
 * in `smtp-config.ts`.
 */
export interface SpiedResolve {
  applicationId: string;
  provider: SocialProviderId;
  hit: boolean;
}
let testSocialSpy: ((e: SpiedResolve) => void) | null = null;
export function _setTestSocialSpy(fn: ((e: SpiedResolve) => void) | null): void {
  testSocialSpy = fn;
}

async function resolvePerApp(
  applicationId: string,
  provider: SocialProviderId,
): Promise<ResolvedSocialProvider | null> {
  const now = Date.now();
  const key = cacheKey(applicationId, provider);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    testSocialSpy?.({ applicationId, provider, hit: cached.value !== null });
    return cached.value;
  }

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

  if (!row) {
    cache.set(key, { value: null, expiresAt: now + NULL_TTL_MS });
    testSocialSpy?.({ applicationId, provider, hit: false });
    return null;
  }

  const decrypted = decryptCredentials<{ clientSecret: string }>(row.clientSecretEncrypted);
  const value: ResolvedSocialProvider = {
    clientId: row.clientId,
    clientSecret: decrypted.clientSecret,
    scopes: row.scopes,
    source: "per-app",
  };
  cache.set(key, { value, expiresAt: now + PER_APP_TTL_MS });
  testSocialSpy?.({ applicationId, provider, hit: true });
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
export function invalidateSocialCache(applicationId: string, provider?: SocialProviderId): void {
  if (provider) {
    cache.delete(cacheKey(applicationId, provider));
    return;
  }
  cache.delete(cacheKey(applicationId, "google"));
  cache.delete(cacheKey(applicationId, "github"));
}

/** Test-only: clear the entire cache. */
export function _clearSocialCacheForTesting(): void {
  cache.clear();
}
