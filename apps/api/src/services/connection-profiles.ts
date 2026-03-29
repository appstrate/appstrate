/**
 * Connection Profiles — manages actor and org connection profiles and profile resolution.
 */

import { eq, and, count } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionProfiles,
  userPackageProfiles,
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
): Promise<(ConnectionProfile & { bindingCount: number })[]> {
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
      bindingCount: count(orgProfileProviderBindings.providerId),
    })
    .from(connectionProfiles)
    .leftJoin(
      orgProfileProviderBindings,
      eq(orgProfileProviderBindings.orgProfileId, connectionProfiles.id),
    )
    .where(eq(connectionProfiles.orgId, orgId))
    .groupBy(connectionProfiles.id);

  return rows;
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

// ─── Profile Resolution ─────────────────────────────────────

/**
 * Get the effective profile ID for an actor+package combination.
 * Returns the override if one exists, otherwise the default.
 */
export async function getEffectiveProfileId(actor: Actor, packageId?: string): Promise<string> {
  if (packageId) {
    const [override] = await db
      .select({ profileId: userPackageProfiles.profileId })
      .from(userPackageProfiles)
      .where(
        and(
          actorFilter(actor, {
            userId: userPackageProfiles.userId,
            endUserId: userPackageProfiles.endUserId,
          }),
          eq(userPackageProfiles.packageId, packageId),
        ),
      )
      .limit(1);

    if (override) return override.profileId;
  }

  return (await ensureDefaultProfile(actor)).id;
}

export async function setPackageProfileOverride(
  actor: Actor,
  packageId: string,
  profileId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: userPackageProfiles.id })
    .from(userPackageProfiles)
    .where(
      and(
        actorFilter(actor, {
          userId: userPackageProfiles.userId,
          endUserId: userPackageProfiles.endUserId,
        }),
        eq(userPackageProfiles.packageId, packageId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(userPackageProfiles)
      .set({ profileId, updatedAt: new Date() })
      .where(eq(userPackageProfiles.id, existing.id));
  } else {
    await db
      .insert(userPackageProfiles)
      .values({ ...actorInsert(actor), packageId, profileId, updatedAt: new Date() });
  }
}

export async function removePackageProfileOverride(actor: Actor, packageId: string): Promise<void> {
  await db.delete(userPackageProfiles).where(
    and(
      actorFilter(actor, {
        userId: userPackageProfiles.userId,
        endUserId: userPackageProfiles.endUserId,
      }),
      eq(userPackageProfiles.packageId, packageId),
    ),
  );
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
 * - Org profile: each provider resolves via org_profile_provider_bindings → source user profile.
 *   Unbound providers fall back to the actor's personal profile (if available).
 * - User/end-user profile: all providers use the profile directly.
 */
export async function resolveProviderProfiles(
  providers: FlowProviderRequirement[],
  actor: Actor | null,
  packageId: string,
  orgId: string,
  profileIdOverride?: string,
): Promise<ProviderProfileMap> {
  if (!profileIdOverride && !actor) {
    throw new Error("Either profileIdOverride or actor must be provided");
  }
  const effectiveProfileId = profileIdOverride ?? (await getEffectiveProfileId(actor!, packageId));
  const profile = await getProfileById(effectiveProfileId);
  if (!profile) throw new Error("Profile not found");

  const map: ProviderProfileMap = {};

  if (profile.orgId) {
    // Org profile: resolve each provider via bindings → source user profile
    const bindings = await getOrgProfileBindings(effectiveProfileId);

    // Fallback: actor's personal profile for providers not bound in the org profile
    const fallbackProfileId = actor ? await getEffectiveProfileId(actor, packageId) : null;

    for (const svc of providers) {
      const sourceProfileId = bindings[svc.id];
      if (sourceProfileId) {
        map[svc.id] = { profileId: sourceProfileId, source: "org_binding" };
      } else if (fallbackProfileId) {
        map[svc.id] = { profileId: fallbackProfileId, source: "user_profile" };
      }
    }
  } else {
    // User/end-user profile: all providers use this profile directly
    for (const svc of providers) {
      map[svc.id] = { profileId: effectiveProfileId, source: "user_profile" };
    }
  }

  return map;
}
