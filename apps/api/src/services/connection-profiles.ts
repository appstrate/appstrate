/**
 * Connection Profiles — manages actor and org connection profiles and profile resolution.
 */

import { eq, and, count, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionProfiles,
  userFlowProviderProfiles,
  userProviderConnections,
  orgProfileProviderBindings,
} from "@appstrate/db/schema";
import type { ConnectionProfile } from "@appstrate/db/schema";
import { type Actor, actorInsert, actorFilter } from "../lib/actor.ts";
import { getOrgProfileBindings } from "./state/index.ts";
import type { FlowProviderRequirement, ProviderProfileMap } from "../types/index.ts";

// ─── Profile CRUD ─────────────────────────────────────────────

/**
 * Ensure a default profile exists for the actor. Creates one if missing.
 */
export async function ensureDefaultProfile(actor: Actor): Promise<ConnectionProfile> {
  const [existing] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        actorFilter(actor, {
          userId: connectionProfiles.userId,
          endUserId: connectionProfiles.endUserId,
        }),
        eq(connectionProfiles.isDefault, true),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(connectionProfiles)
    .values({
      ...actorInsert(actor),
      name: "Default",
      isDefault: true,
    })
    .returning();

  return created!;
}

export async function listProfiles(
  actor: Actor,
): Promise<(ConnectionProfile & { connectionCount: number })[]> {
  const rows = await db
    .select({
      id: connectionProfiles.id,
      userId: connectionProfiles.userId,
      endUserId: connectionProfiles.endUserId,
      orgId: connectionProfiles.orgId,
      name: connectionProfiles.name,
      isDefault: connectionProfiles.isDefault,
      createdAt: connectionProfiles.createdAt,
      updatedAt: connectionProfiles.updatedAt,
      connectionCount: count(userProviderConnections.id),
    })
    .from(connectionProfiles)
    .leftJoin(userProviderConnections, eq(userProviderConnections.profileId, connectionProfiles.id))
    .where(
      actorFilter(actor, {
        userId: connectionProfiles.userId,
        endUserId: connectionProfiles.endUserId,
      }),
    )
    .groupBy(connectionProfiles.id);

  return rows;
}

/**
 * Get a single profile by ID, scoped to the actor. Returns null if not found.
 */
export async function getProfileForActor(
  profileId: string,
  actor: Actor,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        actorFilter(actor, {
          userId: connectionProfiles.userId,
          endUserId: connectionProfiles.endUserId,
        }),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createProfile(actor: Actor, name: string): Promise<ConnectionProfile> {
  const [created] = await db
    .insert(connectionProfiles)
    .values({ ...actorInsert(actor), name, isDefault: false })
    .returning();
  return created!;
}

export async function renameProfile(profileId: string, actor: Actor, name: string): Promise<void> {
  const [updated] = await db
    .update(connectionProfiles)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        actorFilter(actor, {
          userId: connectionProfiles.userId,
          endUserId: connectionProfiles.endUserId,
        }),
      ),
    )
    .returning({ id: connectionProfiles.id });

  if (!updated) throw new Error("Profile not found");
}

export async function deleteProfile(profileId: string, actor: Actor): Promise<void> {
  // Check it's not the default
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        actorFilter(actor, {
          userId: connectionProfiles.userId,
          endUserId: connectionProfiles.endUserId,
        }),
      ),
    )
    .limit(1);

  if (!profile) throw new Error("Profile not found");
  if (profile.isDefault) throw new Error("Cannot delete the default profile");

  await db.delete(connectionProfiles).where(
    and(
      eq(connectionProfiles.id, profileId),
      actorFilter(actor, {
        userId: connectionProfiles.userId,
        endUserId: connectionProfiles.endUserId,
      }),
    ),
  );
}

// ─── Org Profile CRUD ───────────────────────────────────────

export async function listOrgProfiles(
  orgId: string,
): Promise<(ConnectionProfile & { bindingCount: number; boundProviderIds: string[] })[]> {
  // Fetch profiles
  const profileRows = await db
    .select()
    .from(connectionProfiles)
    .where(eq(connectionProfiles.orgId, orgId));

  if (profileRows.length === 0) return [];

  // Fetch all bindings for these profiles in a single query
  const profileIds = profileRows.map((p) => p.id);
  const bindingRows = await db
    .select({
      orgProfileId: orgProfileProviderBindings.orgProfileId,
      providerId: orgProfileProviderBindings.providerId,
    })
    .from(orgProfileProviderBindings)
    .where(inArray(orgProfileProviderBindings.orgProfileId, profileIds));

  // Group bindings by profile
  const bindingsByProfile = new Map<string, string[]>();
  for (const row of bindingRows) {
    const list = bindingsByProfile.get(row.orgProfileId) ?? [];
    list.push(row.providerId);
    bindingsByProfile.set(row.orgProfileId, list);
  }

  return profileRows.map((p) => {
    const providerIds = bindingsByProfile.get(p.id) ?? [];
    return { ...p, bindingCount: providerIds.length, boundProviderIds: providerIds };
  });
}

export async function createOrgProfile(orgId: string, name: string): Promise<ConnectionProfile> {
  const [created] = await db
    .insert(connectionProfiles)
    .values({ orgId, name, isDefault: false })
    .returning();
  return created!;
}

export async function getOrgProfile(
  profileId: string,
  orgId: string,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

export async function renameOrgProfile(
  profileId: string,
  orgId: string,
  name: string,
): Promise<void> {
  const [updated] = await db
    .update(connectionProfiles)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.orgId, orgId)))
    .returning({ id: connectionProfiles.id });

  if (!updated) throw new Error("Profile not found");
}

export async function deleteOrgProfile(profileId: string, orgId: string): Promise<void> {
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.orgId, orgId)))
    .limit(1);

  if (!profile) throw new Error("Profile not found");

  await db
    .delete(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.orgId, orgId)));
}

/**
 * List org profiles where a specific user has active bindings.
 * Used to show users which org profiles depend on their credentials.
 */
export async function listOrgProfilesWithUserBindings(
  userId: string,
  orgId: string,
): Promise<{ profile: ConnectionProfile; providerIds: string[] }[]> {
  const rows = await db
    .select({
      orgProfileId: orgProfileProviderBindings.orgProfileId,
      providerId: orgProfileProviderBindings.providerId,
      profileName: connectionProfiles.name,
    })
    .from(orgProfileProviderBindings)
    .innerJoin(
      connectionProfiles,
      eq(connectionProfiles.id, orgProfileProviderBindings.orgProfileId),
    )
    .where(
      and(
        eq(orgProfileProviderBindings.boundByUserId, userId),
        eq(connectionProfiles.orgId, orgId),
      ),
    );

  const grouped = new Map<string, { profileName: string; providerIds: string[] }>();
  for (const row of rows) {
    const entry = grouped.get(row.orgProfileId) ?? {
      profileName: row.profileName,
      providerIds: [],
    };
    entry.providerIds.push(row.providerId);
    grouped.set(row.orgProfileId, entry);
  }

  return Array.from(grouped.entries()).map(([profileId, data]) => ({
    profile: {
      id: profileId,
      userId: null,
      endUserId: null,
      orgId,
      name: data.profileName,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    providerIds: data.providerIds,
  }));
}

// ─── Per-Provider Profile Overrides ──────────────────────────

/** Get all per-provider profile overrides for an actor+flow combination. */
export async function getUserFlowProviderOverrides(
  actor: Actor,
  packageId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      providerId: userFlowProviderProfiles.providerId,
      profileId: userFlowProviderProfiles.profileId,
    })
    .from(userFlowProviderProfiles)
    .where(
      and(
        actorFilter(actor, {
          userId: userFlowProviderProfiles.userId,
          endUserId: userFlowProviderProfiles.endUserId,
        }),
        eq(userFlowProviderProfiles.packageId, packageId),
      ),
    );

  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.providerId] = row.profileId;
  }
  return map;
}

/** Set a per-provider profile override (upsert). */
export async function setUserFlowProviderOverride(
  actor: Actor,
  packageId: string,
  providerId: string,
  profileId: string,
): Promise<void> {
  // Use raw SQL upsert since Drizzle partial unique indexes need manual conflict handling
  const actorValues = actorInsert(actor);
  const existing = await db
    .select({ rowid: userFlowProviderProfiles.packageId })
    .from(userFlowProviderProfiles)
    .where(
      and(
        actorFilter(actor, {
          userId: userFlowProviderProfiles.userId,
          endUserId: userFlowProviderProfiles.endUserId,
        }),
        eq(userFlowProviderProfiles.packageId, packageId),
        eq(userFlowProviderProfiles.providerId, providerId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(userFlowProviderProfiles)
      .set({ profileId, updatedAt: new Date() })
      .where(
        and(
          actorFilter(actor, {
            userId: userFlowProviderProfiles.userId,
            endUserId: userFlowProviderProfiles.endUserId,
          }),
          eq(userFlowProviderProfiles.packageId, packageId),
          eq(userFlowProviderProfiles.providerId, providerId),
        ),
      );
  } else {
    await db.insert(userFlowProviderProfiles).values({
      ...actorValues,
      packageId,
      providerId,
      profileId,
      updatedAt: new Date(),
    });
  }
}

/** Remove a per-provider profile override (revert to default). */
export async function removeUserFlowProviderOverride(
  actor: Actor,
  packageId: string,
  providerId: string,
): Promise<void> {
  await db.delete(userFlowProviderProfiles).where(
    and(
      actorFilter(actor, {
        userId: userFlowProviderProfiles.userId,
        endUserId: userFlowProviderProfiles.endUserId,
      }),
      eq(userFlowProviderProfiles.packageId, packageId),
      eq(userFlowProviderProfiles.providerId, providerId),
    ),
  );
}

/** Get the default profile ID for an actor. */
export async function getDefaultProfileId(actor: Actor): Promise<string> {
  return (await ensureDefaultProfile(actor)).id;
}

/**
 * Get a profile by ID without actor scoping. Used by scheduler to load the
 * profile referenced by a schedule's connectionProfileId.
 */
export async function getProfileById(profileId: string): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(eq(connectionProfiles.id, profileId))
    .limit(1);
  return row ?? null;
}

// ─── Provider Profile Resolution ────────────────────────────

/**
 * Resolve profile IDs for each provider in a package.
 *
 * Three-layer resolution (highest priority first):
 * 1. orgProfileId binding → source: "org_binding"
 * 2. Per-provider user override → source: "user_profile"
 * 3. Default user profile → source: "user_profile"
 *
 * For schedules: pass the schedule's connectionProfileId as defaultUserProfileId
 * with orgProfileId if the schedule uses an org profile. No per-provider overrides.
 */
export async function resolveProviderProfiles(
  providers: FlowProviderRequirement[],
  defaultUserProfileId: string,
  userProviderOverrides?: Record<string, string>,
  orgProfileId?: string | null,
): Promise<ProviderProfileMap> {
  const map: ProviderProfileMap = {};

  // Load org bindings if an org profile is provided
  let bindings: Record<string, string> = {};
  if (orgProfileId) {
    bindings = await getOrgProfileBindings(orgProfileId);
  }

  for (const svc of providers) {
    const orgBinding = orgProfileId ? bindings[svc.id] : undefined;
    if (orgBinding) {
      map[svc.id] = { profileId: orgBinding, source: "org_binding" };
    } else {
      const overrideProfileId = userProviderOverrides?.[svc.id];
      map[svc.id] = {
        profileId: overrideProfileId ?? defaultUserProfileId,
        source: "user_profile",
      };
    }
  }

  return map;
}
