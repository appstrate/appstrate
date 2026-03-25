/**
 * Connection Profiles — manages actor connection profiles and profile resolution.
 */

import { eq, and, count } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionProfiles,
  userPackageProfiles,
  userProviderConnections,
} from "@appstrate/db/schema";
import type { ConnectionProfile } from "@appstrate/db/schema";
import { type Actor, actorInsert, actorFilter } from "../lib/actor.ts";
import { getFlowProviderBindings } from "./state/index.ts";
import type { FlowProviderRequirement } from "../types/index.ts";

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

// ─── Provider Profile Resolution ────────────────────────────

/**
 * Resolve profile IDs for each provider in a package.
 * Admin providers get their profile from flow_provider_bindings.
 * User providers get the effective profile for the actor+package.
 */
export async function resolveProviderProfiles(
  providers: FlowProviderRequirement[],
  actor: Actor,
  packageId: string,
  orgId: string,
  profileIdOverride?: string,
): Promise<Record<string, string>> {
  const userProfileId = profileIdOverride ?? (await getEffectiveProfileId(actor, packageId));
  const bindings = await getFlowProviderBindings(orgId, packageId);
  const map: Record<string, string> = {};

  for (const svc of providers) {
    const mode = svc.connectionMode ?? "user";
    if (mode === "admin") {
      const adminProfileId = bindings[svc.id];
      if (adminProfileId) {
        map[svc.id] = adminProfileId;
      }
    } else {
      map[svc.id] = userProfileId;
    }
  }

  return map;
}
