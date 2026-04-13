// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application social auth admin service.
 *
 * CRUD over `application_social_providers` keyed by (applicationId, provider).
 * Client secret column is never returned — `SocialProviderView` omits it by
 * construction. Mutations always invalidate the resolver cache so the admin
 * sees updates within one request instead of waiting out the TTL.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { encryptCredentials } from "@appstrate/connect";
import { applicationSocialProviders } from "../schema.ts";
import { invalidateSocialCache, type SocialProviderId } from "./social-config.ts";

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

function mapRow(row: typeof applicationSocialProviders.$inferSelect): SocialProviderView {
  return {
    applicationId: row.applicationId,
    provider: row.provider,
    clientId: row.clientId,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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
  invalidateSocialCache(applicationId, provider);
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
  invalidateSocialCache(applicationId, provider);
  return deleted.length > 0;
}
