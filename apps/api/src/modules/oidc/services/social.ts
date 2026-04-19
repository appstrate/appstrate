// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application social auth: resolver + admin CRUD.
 *
 * Resolver:
 *  - `level=application` → reads `application_social_providers` for the
 *    referenced app. Absent → `null` (that provider's button is hidden on the
 *    tenant's login pages; no fallback to env creds).
 *  - `level=org` / `level=instance` → NOT handled here. The env-based creds
 *    baked into the BA singleton at boot (see `packages/db/src/auth.ts`)
 *    continue to apply; a `null` return from this resolver means "no per-app
 *    override" and the env getters take over.
 *
 * Admin:
 *  - CRUD keyed by (applicationId, provider). Views never expose the client
 *    secret. Mutations invalidate the resolver cache.
 *
 * Rotation:
 *  - Each row carries `ENCRYPTION_KEY_VERSION`; mismatches surface as
 *    "not configured" to avoid throws on stale ciphertext.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { decryptCredentials, encryptCredentials } from "@appstrate/connect";
import { applicationSocialProviders } from "../schema.ts";
import type { OAuthClientRecord } from "./oauth-admin.ts";
import { createTtlCache } from "./ttl-cache.ts";
import { logger } from "../../../lib/logger.ts";

const ENCRYPTION_KEY_VERSION = "v1";

export type SocialProviderId = "google" | "github";

export interface ResolvedSocialProvider {
  clientId: string;
  clientSecret: string;
  scopes: string[] | null;
  source: "per-app";
}

export interface SocialProviderView {
  applicationId: string;
  provider: SocialProviderId;
  clientId: string;
  scopes: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSocialProviderInput {
  clientId: string;
  clientSecret: string;
  scopes?: string[] | null;
}

const cache = createTtlCache<ResolvedSocialProvider>("oidc:social-cache-invalidate");

function cacheKey(applicationId: string, provider: SocialProviderId): string {
  return `${applicationId}:${provider}`;
}

export interface SpiedSocialResolve {
  applicationId: string;
  provider: SocialProviderId;
  hit: boolean;
}
let socialResolveSpy: ((e: SpiedSocialResolve) => void) | null = null;
export function _setSocialSpy(fn: ((e: SpiedSocialResolve) => void) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("_setSocialSpy is test-only");
  socialResolveSpy = fn;
}

type SocialRow = typeof applicationSocialProviders.$inferSelect;

function mapRow(row: SocialRow): SocialProviderView {
  return {
    applicationId: row.applicationId,
    provider: row.provider,
    clientId: row.clientId,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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
    if (row.encryptionKeyVersion !== ENCRYPTION_KEY_VERSION) {
      logger.warn("oidc social: stale encryption key version, treating as unconfigured", {
        applicationId,
        provider,
        rowVersion: row.encryptionKeyVersion,
        currentVersion: ENCRYPTION_KEY_VERSION,
      });
      return null;
    }
    let decrypted: { clientSecret: string };
    try {
      decrypted = decryptCredentials<{ clientSecret: string }>(row.clientSecretEncrypted);
    } catch (err) {
      logger.error("oidc social: decryption failed for per-app creds, treating as unconfigured", {
        applicationId,
        provider,
        rowVersion: row.encryptionKeyVersion,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    return {
      clientId: row.clientId,
      clientSecret: decrypted.clientSecret,
      scopes: row.scopes,
      source: "per-app",
    };
  });
  if (socialResolveSpy) socialResolveSpy({ applicationId, provider, hit: value !== null });
  return value;
}

/** Resolve per-app OAuth creds. Returns `null` for non-application clients or when absent. */
export async function resolveSocialProviderForClient(
  client: Pick<OAuthClientRecord, "level" | "referencedApplicationId">,
  provider: SocialProviderId,
): Promise<ResolvedSocialProvider | null> {
  if (client.level !== "application") return null;
  if (!client.referencedApplicationId) return null;
  return resolvePerApp(client.referencedApplicationId, provider);
}

/** Invalidate cached entries for an application (both providers when `provider` omitted). */
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

// ───────────────────────── Admin CRUD ─────────────────────────

export async function getSocialProvider(
  applicationId: string,
  provider: SocialProviderId,
): Promise<SocialProviderView | null> {
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
  return row ? mapRow(row) : null;
}

export async function upsertSocialProvider(
  applicationId: string,
  provider: SocialProviderId,
  input: UpsertSocialProviderInput,
): Promise<SocialProviderView> {
  const clientSecretEncrypted = encryptCredentials({ clientSecret: input.clientSecret });
  const now = new Date();
  const values = {
    applicationId,
    provider,
    clientId: input.clientId,
    clientSecretEncrypted,
    encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
    scopes: input.scopes ?? null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(applicationSocialProviders)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: [applicationSocialProviders.applicationId, applicationSocialProviders.provider],
      set: values,
    })
    .returning();
  await invalidateSocialCache(applicationId, provider);
  return mapRow(row!);
}

export async function deleteSocialProvider(
  applicationId: string,
  provider: SocialProviderId,
): Promise<boolean> {
  const deleted = await db
    .delete(applicationSocialProviders)
    .where(
      and(
        eq(applicationSocialProviders.applicationId, applicationId),
        eq(applicationSocialProviders.provider, provider),
      ),
    )
    .returning({ applicationId: applicationSocialProviders.applicationId });
  await invalidateSocialCache(applicationId, provider);
  return deleted.length > 0;
}
