// SPDX-License-Identifier: Apache-2.0

/**
 * Per-space social auth: resolver + admin CRUD.
 *
 * Resolver:
 *  - `level=space` → reads `space_social_providers` for the
 *    referenced space. Absent → `null` (that provider's button is hidden on the
 *    tenant's login pages; no fallback to env creds).
 *  - `level=org` / `level=instance` → NOT handled here. The env-based creds
 *    baked into the BA singleton at boot (see `packages/db/src/auth.ts`)
 *    continue to apply; a `null` return from this resolver means "no per-space
 *    override" and the env getters take over.
 *
 * Admin:
 *  - CRUD keyed by (spaceId, provider). Views never expose the client
 *    secret. Mutations invalidate the resolver cache.
 *
 * Rotation:
 *  - Ciphertexts are self-describing `v1:<kid>:` envelopes (`@appstrate/connect`).
 *    Key rotation rides the connect keyring; a row whose kid is no longer in
 *    the keyring fails decryption and surfaces as "not configured".
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { decryptCredentials, encryptCredentials } from "@appstrate/connect";
import type { SocialProviderId, SocialProviderView } from "@appstrate/shared-types";
import { spaceSocialProviders } from "@appstrate/db/schema";
import type { OAuthClientRecord } from "./oauth-admin.ts";
import { createTtlCache } from "./ttl-cache.ts";
import { logger } from "../../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export type { SocialProviderId };

interface ResolvedSocialProvider {
  clientId: string;
  clientSecret: string;
  scopes: string[] | null;
  source: "per-space";
}

interface UpsertSocialProviderInput {
  clientId: string;
  clientSecret: string;
  scopes?: string[] | null;
}

/**
 * Canonical runtime list of every supported social provider. Single source of
 * truth for iterating over providers (e.g. cache invalidation) instead of
 * hardcoding the pair at each callsite. The compile-time assertion below fails
 * the build if `SocialProviderId` gains a member that is not listed here, so
 * the list can never silently drift out of sync with the type.
 */
export const SOCIAL_PROVIDER_IDS = [
  "google",
  "github",
] as const satisfies readonly SocialProviderId[];
// If this line errors, a new SocialProviderId was added — append it above.
type _AssertAllProvidersListed =
  Exclude<SocialProviderId, (typeof SOCIAL_PROVIDER_IDS)[number]> extends never ? true : never;
const _assertAllProvidersListed: _AssertAllProvidersListed = true;
void _assertAllProvidersListed;

const cache = createTtlCache<ResolvedSocialProvider>("oidc:social-cache-invalidate");

function cacheKey(spaceId: string, provider: SocialProviderId): string {
  return `${spaceId}:${provider}`;
}

export interface SpiedSocialResolve {
  spaceId: string;
  provider: SocialProviderId;
  hit: boolean;
}
let socialResolveSpy: ((e: SpiedSocialResolve) => void) | null = null;
export function _setSocialSpy(fn: ((e: SpiedSocialResolve) => void) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("_setSocialSpy is test-only");
  socialResolveSpy = fn;
}

type SocialRow = typeof spaceSocialProviders.$inferSelect;

function mapRow(row: SocialRow): SocialProviderView {
  return {
    spaceId: row.spaceId,
    provider: row.provider,
    clientId: row.clientId,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function resolvePerApp(
  spaceId: string,
  provider: SocialProviderId,
): Promise<ResolvedSocialProvider | null> {
  const key = cacheKey(spaceId, provider);
  const value = await cache.getOrLoad(key, async () => {
    const [row] = await db
      .select()
      .from(spaceSocialProviders)
      .where(
        and(eq(spaceSocialProviders.spaceId, spaceId), eq(spaceSocialProviders.provider, provider)),
      )
      .limit(1);
    if (!row) return null;
    let decrypted: { clientSecret: string };
    try {
      decrypted = decryptCredentials<{ clientSecret: string }>(row.clientSecretEncrypted);
    } catch (err) {
      logger.error("oidc social: decryption failed for per-space creds, treating as unconfigured", {
        spaceId,
        provider,
        error: getErrorMessage(err),
      });
      return null;
    }
    return {
      clientId: row.clientId,
      clientSecret: decrypted.clientSecret,
      scopes: row.scopes,
      source: "per-space",
    };
  });
  if (socialResolveSpy) socialResolveSpy({ spaceId, provider, hit: value !== null });
  return value;
}

/** Resolve per-space OAuth creds. Returns `null` for non-space clients or when absent. */
export async function resolveSocialProviderForClient(
  client: Pick<OAuthClientRecord, "level" | "referencedSpaceId">,
  provider: SocialProviderId,
): Promise<ResolvedSocialProvider | null> {
  if (client.level !== "space") return null;
  if (!client.referencedSpaceId) return null;
  return resolvePerApp(client.referencedSpaceId, provider);
}

/** Invalidate cached entries for a space (both providers when `provider` omitted). */
export async function invalidateSocialCache(
  spaceId: string,
  provider?: SocialProviderId,
): Promise<void> {
  if (provider) {
    await cache.delete(cacheKey(spaceId, provider));
    return;
  }
  await Promise.all(SOCIAL_PROVIDER_IDS.map((p) => cache.delete(cacheKey(spaceId, p))));
}

/** Test-only: clear the entire cache. */
export function _clearSocialCacheForTesting(): void {
  cache.clearForTesting();
}

// ───────────────────────── Admin CRUD ─────────────────────────

export async function getSocialProvider(
  spaceId: string,
  provider: SocialProviderId,
): Promise<SocialProviderView | null> {
  const [row] = await db
    .select()
    .from(spaceSocialProviders)
    .where(
      and(eq(spaceSocialProviders.spaceId, spaceId), eq(spaceSocialProviders.provider, provider)),
    )
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function upsertSocialProvider(
  spaceId: string,
  provider: SocialProviderId,
  input: UpsertSocialProviderInput,
): Promise<SocialProviderView> {
  const clientSecretEncrypted = encryptCredentials({ clientSecret: input.clientSecret });
  const now = new Date();
  const values = {
    spaceId,
    provider,
    clientId: input.clientId,
    clientSecretEncrypted,
    scopes: input.scopes ?? null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(spaceSocialProviders)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: [spaceSocialProviders.spaceId, spaceSocialProviders.provider],
      set: values,
    })
    .returning();
  await invalidateSocialCache(spaceId, provider);
  return mapRow(row!);
}

export async function deleteSocialProvider(
  spaceId: string,
  provider: SocialProviderId,
): Promise<boolean> {
  const deleted = await db
    .delete(spaceSocialProviders)
    .where(
      and(eq(spaceSocialProviders.spaceId, spaceId), eq(spaceSocialProviders.provider, provider)),
    )
    .returning({ spaceId: spaceSocialProviders.spaceId });
  await invalidateSocialCache(spaceId, provider);
  return deleted.length > 0;
}
