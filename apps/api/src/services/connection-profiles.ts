/**
 * Connection Profiles — manages user connection profiles and profile resolution.
 */

import { eq, and, count } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { connectionProfiles, userPackageProfiles, serviceConnections } from "@appstrate/db/schema";
import type { ConnectionProfile } from "@appstrate/db/schema";
import { getAdminConnections } from "./state.ts";
import type { FlowProviderRequirement } from "../types/index.ts";

// ─── Profile CRUD ─────────────────────────────────────────────

/**
 * Ensure a default profile exists for the user. Creates one if missing.
 */
export async function ensureDefaultProfile(userId: string): Promise<ConnectionProfile> {
  const [existing] = await db
    .select()
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.userId, userId), eq(connectionProfiles.isDefault, true)))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(connectionProfiles)
    .values({
      userId,
      name: "Default",
      isDefault: true,
    })
    .returning();

  return created!;
}

export async function listProfiles(
  userId: string,
): Promise<(ConnectionProfile & { connectionCount: number })[]> {
  const rows = await db
    .select({
      id: connectionProfiles.id,
      userId: connectionProfiles.userId,
      name: connectionProfiles.name,
      isDefault: connectionProfiles.isDefault,
      createdAt: connectionProfiles.createdAt,
      updatedAt: connectionProfiles.updatedAt,
      connectionCount: count(serviceConnections.id),
    })
    .from(connectionProfiles)
    .leftJoin(serviceConnections, eq(serviceConnections.profileId, connectionProfiles.id))
    .where(eq(connectionProfiles.userId, userId))
    .groupBy(connectionProfiles.id);

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    isDefault: r.isDefault,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    connectionCount: r.connectionCount,
  }));
}

/**
 * Get a single profile by ID, scoped to the user. Returns null if not found.
 */
export async function getProfileForUser(
  profileId: string,
  userId: string,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createProfile(userId: string, name: string): Promise<ConnectionProfile> {
  const [created] = await db
    .insert(connectionProfiles)
    .values({ userId, name, isDefault: false })
    .returning();
  return created!;
}

export async function renameProfile(
  profileId: string,
  userId: string,
  name: string,
): Promise<void> {
  const [updated] = await db
    .update(connectionProfiles)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.userId, userId)))
    .returning({ id: connectionProfiles.id });

  if (!updated) throw new Error("Profile not found");
}

export async function deleteProfile(profileId: string, userId: string): Promise<void> {
  // Check it's not the default
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.userId, userId)))
    .limit(1);

  if (!profile) throw new Error("Profile not found");
  if (profile.isDefault) throw new Error("Cannot delete the default profile");

  await db
    .delete(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.userId, userId)));
}

// ─── Profile Resolution ─────────────────────────────────────

export async function getDefaultProfileId(userId: string): Promise<string> {
  const profile = await ensureDefaultProfile(userId);
  return profile.id;
}

/**
 * Get the effective profile ID for a user+package combination.
 * Returns the override if one exists, otherwise the default.
 */
export async function getEffectiveProfileId(userId: string, packageId?: string): Promise<string> {
  if (packageId) {
    const [override] = await db
      .select({ profileId: userPackageProfiles.profileId })
      .from(userPackageProfiles)
      .where(
        and(eq(userPackageProfiles.userId, userId), eq(userPackageProfiles.packageId, packageId)),
      )
      .limit(1);

    if (override) return override.profileId;
  }

  return getDefaultProfileId(userId);
}

export async function setPackageProfileOverride(
  userId: string,
  packageId: string,
  profileId: string,
): Promise<void> {
  await db
    .insert(userPackageProfiles)
    .values({ userId, packageId, profileId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userPackageProfiles.userId, userPackageProfiles.packageId],
      set: { profileId, updatedAt: new Date() },
    });
}

export async function removePackageProfileOverride(
  userId: string,
  packageId: string,
): Promise<void> {
  await db
    .delete(userPackageProfiles)
    .where(
      and(eq(userPackageProfiles.userId, userId), eq(userPackageProfiles.packageId, packageId)),
    );
}

// ─── Provider Profile Resolution ────────────────────────────

/**
 * Resolve profile IDs for each provider in a package.
 * Admin providers get their profile from package_admin_connections.
 * User providers get the effective profile for the user+package.
 */
export async function resolveProviderProfiles(
  providers: FlowProviderRequirement[],
  userId: string,
  packageId: string,
  orgId: string,
  profileIdOverride?: string,
): Promise<Record<string, string>> {
  const userProfileId = profileIdOverride ?? (await getEffectiveProfileId(userId, packageId));
  const adminConns = await getAdminConnections(orgId, packageId);
  const map: Record<string, string> = {};

  for (const svc of providers) {
    const mode = svc.connectionMode ?? "user";
    if (mode === "admin") {
      const adminProfileId = adminConns[svc.id];
      if (adminProfileId) {
        map[svc.id] = adminProfileId;
      }
    } else {
      map[svc.id] = userProfileId;
    }
  }

  return map;
}
