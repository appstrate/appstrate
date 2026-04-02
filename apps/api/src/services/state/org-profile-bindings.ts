// SPDX-License-Identifier: Apache-2.0

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  orgProfileProviderBindings,
  connectionProfiles,
  userProviderConnections,
} from "@appstrate/db/schema";
import { user } from "@appstrate/db/schema";
import type { EnrichedBinding } from "@appstrate/shared-types";
import { notFound } from "../../lib/errors.ts";
export type { EnrichedBinding };

/** Verify that the org profile exists and belongs to the org. Throws 404 if not found. */
async function assertOrgProfileOwnership(orgProfileId: string, orgId: string): Promise<void> {
  const [owner] = await db
    .select({ id: connectionProfiles.id })
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.id, orgProfileId), eq(connectionProfiles.orgId, orgId)))
    .limit(1);
  if (!owner) throw notFound("Profile not found");
}

/**
 * Get all bindings for an org profile: { providerId → sourceProfileId }.
 *
 * CALLER CONTRACT: The caller must verify that orgProfileId belongs to the
 * requesting org (via getOrgProfile(id, orgId)) before calling this function.
 * This function does not filter by orgId for performance — the orgProfileId
 * foreign key implicitly scopes to a single org.
 */
export async function getOrgProfileBindings(
  orgProfileId: string,
  orgId: string,
): Promise<Record<string, string>> {
  await assertOrgProfileOwnership(orgProfileId, orgId);

  const rows = await db
    .select({
      providerId: orgProfileProviderBindings.providerId,
      sourceProfileId: orgProfileProviderBindings.sourceProfileId,
    })
    .from(orgProfileProviderBindings)
    .where(eq(orgProfileProviderBindings.orgProfileId, orgProfileId));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.providerId] = row.sourceProfileId;
  }
  return result;
}

/**
 * Get all bindings for an org profile with profile name, user name, and connection status.
 *
 * CALLER CONTRACT: Same as getOrgProfileBindings — caller must validate org ownership first.
 */
export async function getOrgProfileBindingsEnriched(
  orgProfileId: string,
  orgId: string,
): Promise<EnrichedBinding[]> {
  await assertOrgProfileOwnership(orgProfileId, orgId);

  const rows = await db
    .select({
      providerId: orgProfileProviderBindings.providerId,
      sourceProfileId: orgProfileProviderBindings.sourceProfileId,
      sourceProfileName: connectionProfiles.name,
      boundByUserName: user.name,
      connectionId: userProviderConnections.id,
    })
    .from(orgProfileProviderBindings)
    .innerJoin(
      connectionProfiles,
      eq(connectionProfiles.id, orgProfileProviderBindings.sourceProfileId),
    )
    .leftJoin(user, eq(user.id, orgProfileProviderBindings.boundByUserId))
    .leftJoin(
      userProviderConnections,
      and(
        eq(userProviderConnections.profileId, orgProfileProviderBindings.sourceProfileId),
        eq(userProviderConnections.providerId, orgProfileProviderBindings.providerId),
      ),
    )
    .where(eq(orgProfileProviderBindings.orgProfileId, orgProfileId));

  return rows.map((r) => ({
    providerId: r.providerId,
    sourceProfileId: r.sourceProfileId,
    sourceProfileName: r.sourceProfileName,
    boundByUserName: r.boundByUserName,
    connected: r.connectionId != null,
  }));
}

/** Bind an org profile's provider slot to a user's personal profile (upsert). */
export async function bindOrgProfileProvider(
  orgProfileId: string,
  providerId: string,
  sourceProfileId: string,
  boundByUserId: string,
): Promise<void> {
  await db
    .insert(orgProfileProviderBindings)
    .values({
      orgProfileId,
      providerId,
      sourceProfileId,
      boundByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [orgProfileProviderBindings.orgProfileId, orgProfileProviderBindings.providerId],
      set: {
        sourceProfileId,
        boundByUserId,
        updatedAt: new Date(),
      },
    });
}

/** Get the userId who created a binding (null if no binding exists). */
export async function getBindingOwner(
  orgProfileId: string,
  providerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ boundByUserId: orgProfileProviderBindings.boundByUserId })
    .from(orgProfileProviderBindings)
    .where(
      and(
        eq(orgProfileProviderBindings.orgProfileId, orgProfileId),
        eq(orgProfileProviderBindings.providerId, providerId),
      ),
    )
    .limit(1);
  return row?.boundByUserId ?? null;
}

/** Unbind a provider from an org profile. */
export async function unbindOrgProfileProvider(
  orgProfileId: string,
  providerId: string,
): Promise<void> {
  await db
    .delete(orgProfileProviderBindings)
    .where(
      and(
        eq(orgProfileProviderBindings.orgProfileId, orgProfileId),
        eq(orgProfileProviderBindings.providerId, providerId),
      ),
    );
}
