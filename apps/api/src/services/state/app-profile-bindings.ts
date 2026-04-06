// SPDX-License-Identifier: Apache-2.0

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  appProfileProviderBindings,
  connectionProfiles,
  userProviderConnections,
} from "@appstrate/db/schema";
import { user } from "@appstrate/db/schema";
import type { EnrichedBinding } from "@appstrate/shared-types";
import { notFound } from "../../lib/errors.ts";
export type { EnrichedBinding };

/** Verify that the app profile exists and belongs to the application. Throws 404 if not found. */
async function assertAppProfileOwnership(
  appProfileId: string,
  applicationId: string,
): Promise<void> {
  const [owner] = await db
    .select({ id: connectionProfiles.id })
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, appProfileId),
        eq(connectionProfiles.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!owner) throw notFound("Profile not found");
}

/**
 * Get all bindings for an app profile: { providerId → sourceProfileId }.
 *
 * CALLER CONTRACT: The caller must verify that appProfileId belongs to the
 * requesting application (via getAppProfile(id, applicationId)) before calling this function.
 * This function does not filter by applicationId for performance — the appProfileId
 * foreign key implicitly scopes to a single application.
 */
export async function getAppProfileBindings(
  appProfileId: string,
  applicationId: string,
): Promise<Record<string, string>> {
  await assertAppProfileOwnership(appProfileId, applicationId);

  const rows = await db
    .select({
      providerId: appProfileProviderBindings.providerId,
      sourceProfileId: appProfileProviderBindings.sourceProfileId,
    })
    .from(appProfileProviderBindings)
    .where(eq(appProfileProviderBindings.appProfileId, appProfileId));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.providerId] = row.sourceProfileId;
  }
  return result;
}

/**
 * Get all bindings for an app profile with profile name, user name, and connection status.
 *
 * CALLER CONTRACT: Same as getAppProfileBindings — caller must validate application ownership first.
 */
export async function getAppProfileBindingsEnriched(
  appProfileId: string,
  applicationId: string,
): Promise<EnrichedBinding[]> {
  await assertAppProfileOwnership(appProfileId, applicationId);

  const rows = await db
    .select({
      providerId: appProfileProviderBindings.providerId,
      sourceProfileId: appProfileProviderBindings.sourceProfileId,
      sourceProfileName: connectionProfiles.name,
      boundByUserName: user.name,
      connectionId: userProviderConnections.id,
    })
    .from(appProfileProviderBindings)
    .innerJoin(
      connectionProfiles,
      eq(connectionProfiles.id, appProfileProviderBindings.sourceProfileId),
    )
    .leftJoin(user, eq(user.id, appProfileProviderBindings.boundByUserId))
    // NOTE: Connection profiles (user and app) are independent of applications.
    // Connections from different apps accumulate on profiles — each tagged with a
    // providerCredentialId linking it to one app. This LEFT JOIN matches across all
    // apps (no providerCredentialId filter) because app bindings are app-agnostic:
    // "connected" = at least one app has a healthy connection for this provider.
    // Rows are deduplicated below to handle multiple matching connections.
    .leftJoin(
      userProviderConnections,
      and(
        eq(userProviderConnections.profileId, appProfileProviderBindings.sourceProfileId),
        eq(userProviderConnections.providerId, appProfileProviderBindings.providerId),
        eq(userProviderConnections.needsReconnection, false),
      ),
    )
    .where(eq(appProfileProviderBindings.appProfileId, appProfileId));

  // Deduplicate: the LEFT JOIN on userProviderConnections can produce multiple rows
  // per binding when the user has connections from several apps (one per providerCredentialId).
  // We only need to know if at least one healthy connection exists.
  const seen = new Set<string>();
  const result: EnrichedBinding[] = [];
  for (const r of rows) {
    if (seen.has(r.providerId)) continue;
    seen.add(r.providerId);
    result.push({
      providerId: r.providerId,
      sourceProfileId: r.sourceProfileId,
      sourceProfileName: r.sourceProfileName,
      boundByUserName: r.boundByUserName,
      connected: r.connectionId != null,
    });
  }
  return result;
}

/** Bind an app profile's provider slot to a user's personal profile (upsert). */
export async function bindAppProfileProvider(
  appProfileId: string,
  providerId: string,
  sourceProfileId: string,
  boundByUserId: string,
): Promise<void> {
  await db
    .insert(appProfileProviderBindings)
    .values({
      appProfileId,
      providerId,
      sourceProfileId,
      boundByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [appProfileProviderBindings.appProfileId, appProfileProviderBindings.providerId],
      set: {
        sourceProfileId,
        boundByUserId,
        updatedAt: new Date(),
      },
    });
}

/** Get the userId who created a binding (null if no binding exists). */
export async function getBindingOwner(
  appProfileId: string,
  providerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ boundByUserId: appProfileProviderBindings.boundByUserId })
    .from(appProfileProviderBindings)
    .where(
      and(
        eq(appProfileProviderBindings.appProfileId, appProfileId),
        eq(appProfileProviderBindings.providerId, providerId),
      ),
    )
    .limit(1);
  return row?.boundByUserId ?? null;
}

/** Unbind a provider from an app profile. */
export async function unbindAppProfileProvider(
  appProfileId: string,
  providerId: string,
): Promise<void> {
  await db
    .delete(appProfileProviderBindings)
    .where(
      and(
        eq(appProfileProviderBindings.appProfileId, appProfileId),
        eq(appProfileProviderBindings.providerId, providerId),
      ),
    );
}
