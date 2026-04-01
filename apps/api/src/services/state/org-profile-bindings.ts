import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  orgProfileProviderBindings,
  connectionProfiles,
  userProviderConnections,
} from "@appstrate/db/schema";
import { user } from "@appstrate/db/schema";

/** Get all bindings for an org profile: { providerId → sourceProfileId } */
export async function getOrgProfileBindings(orgProfileId: string): Promise<Record<string, string>> {
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

export interface EnrichedBinding {
  providerId: string;
  sourceProfileId: string;
  sourceProfileName: string;
  boundByUserName: string | null;
  /** Whether the source user still has an active connection for this provider. */
  connected: boolean;
}

/** Get all bindings for an org profile with profile name, user name, and connection status. */
export async function getOrgProfileBindingsEnriched(
  orgProfileId: string,
): Promise<EnrichedBinding[]> {
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
