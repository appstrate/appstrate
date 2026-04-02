// SPDX-License-Identifier: Apache-2.0

/**
 * Connection Profiles — manages actor and org connection profiles and profile resolution.
 */

import { eq, and, count, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionProfiles,
  userFlowProviderProfiles,
  userProviderConnections,
  orgProfileProviderBindings,
  organizationMembers,
  packageConfigs,
} from "@appstrate/db/schema";
import type { ConnectionProfile } from "@appstrate/db/schema";
import { type Actor, actorInsert, actorFilter } from "../lib/actor.ts";
import { getOrgProfileBindings } from "./state/index.ts";
import { getPackageConfig } from "./state/package-config.ts";
import type { FlowProviderRequirement, ProviderProfileMap } from "../types/index.ts";
import { notFound, invalidRequest } from "../lib/errors.ts";

const PROFILE_ACTOR_COLUMNS = {
  userId: connectionProfiles.userId,
  endUserId: connectionProfiles.endUserId,
} as const;

// ─── Profile CRUD ─────────────────────────────────────────────

/**
 * Ensure a default profile exists for the actor. Creates one if missing.
 */
export async function ensureDefaultProfile(actor: Actor): Promise<ConnectionProfile> {
  const [existing] = await db
    .select()
    .from(connectionProfiles)
    .where(and(actorFilter(actor, PROFILE_ACTOR_COLUMNS), eq(connectionProfiles.isDefault, true)))
    .limit(1);

  if (existing) return existing;

  try {
    const [created] = await db
      .insert(connectionProfiles)
      .values({
        ...actorInsert(actor),
        name: "Default",
        isDefault: true,
      })
      .returning();

    return created!;
  } catch (err: unknown) {
    // Handle race condition: unique index violation means another request created the profile
    if (err instanceof Error && err.message.includes("idx_connection_profiles_default")) {
      const [existing] = await db
        .select()
        .from(connectionProfiles)
        .where(
          and(actorFilter(actor, PROFILE_ACTOR_COLUMNS), eq(connectionProfiles.isDefault, true)),
        )
        .limit(1);
      if (existing) return existing;
    }
    throw err;
  }
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
    .where(actorFilter(actor, PROFILE_ACTOR_COLUMNS))
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
    .where(and(eq(connectionProfiles.id, profileId), actorFilter(actor, PROFILE_ACTOR_COLUMNS)))
    .limit(1);
  return row ?? null;
}

/**
 * Check if an actor can use a profile: either their own (user/end-user)
 * or an org profile belonging to the actor's current org.
 */
export async function getAccessibleProfile(
  profileId: string,
  actor: Actor,
  orgId: string,
): Promise<ConnectionProfile | null> {
  return (await getProfileForActor(profileId, actor)) ?? (await getOrgProfile(profileId, orgId));
}

/**
 * Get a user profile whose owner is a member of the given org.
 * Used for read-only access (e.g. viewing schedule provider status).
 */
export async function getOrgMemberProfile(
  profileId: string,
  orgId: string,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select({ profile: connectionProfiles })
    .from(connectionProfiles)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, connectionProfiles.userId),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .where(eq(connectionProfiles.id, profileId))
    .limit(1);
  return row?.profile ?? null;
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
    .where(and(eq(connectionProfiles.id, profileId), actorFilter(actor, PROFILE_ACTOR_COLUMNS)))
    .returning({ id: connectionProfiles.id });

  if (!updated) throw notFound("Profile not found");
}

export async function deleteProfile(profileId: string, actor: Actor): Promise<void> {
  // Check it's not the default
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), actorFilter(actor, PROFILE_ACTOR_COLUMNS)))
    .limit(1);

  if (!profile) throw notFound("Profile not found");
  if (profile.isDefault) throw invalidRequest("Cannot delete the default profile");

  await db
    .delete(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), actorFilter(actor, PROFILE_ACTOR_COLUMNS)));
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

/**
 * Load the org profile configured on a flow, returning null if none configured
 * or if the referenced profile was deleted.
 */
export async function getFlowOrgProfile(
  orgId: string,
  packageId: string,
): Promise<{ id: string; name: string } | null> {
  const { orgProfileId } = await getPackageConfig(orgId, packageId);
  if (!orgProfileId) return null;
  const profile = await getOrgProfile(orgProfileId, orgId);
  return profile ? { id: orgProfileId, name: profile.name } : null;
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

  if (!updated) throw notFound("Profile not found");
}

export async function deleteOrgProfile(profileId: string, orgId: string): Promise<void> {
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(and(eq(connectionProfiles.id, profileId), eq(connectionProfiles.orgId, orgId)))
    .limit(1);

  if (!profile) throw notFound("Profile not found");

  // Clear stale orgProfileId references in package_configs before deleting the profile.
  // The FK has onDelete: "set null", but we clear explicitly as defense-in-depth.
  await db
    .update(packageConfigs)
    .set({ orgProfileId: null, updatedAt: new Date() })
    .where(eq(packageConfigs.orgProfileId, profileId));

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
      profileCreatedAt: connectionProfiles.createdAt,
      profileUpdatedAt: connectionProfiles.updatedAt,
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

  const grouped = new Map<
    string,
    { profileName: string; createdAt: Date; updatedAt: Date; providerIds: string[] }
  >();
  for (const row of rows) {
    const entry = grouped.get(row.orgProfileId) ?? {
      profileName: row.profileName,
      createdAt: row.profileCreatedAt,
      updatedAt: row.profileUpdatedAt,
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
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
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

/** Set a per-provider profile override (atomic upsert via raw SQL). */
export async function setUserFlowProviderOverride(
  actor: Actor,
  packageId: string,
  providerId: string,
  profileId: string,
): Promise<void> {
  const actorValues = actorInsert(actor);
  const userId = actorValues.userId ?? null;
  const endUserId = actorValues.endUserId ?? null;

  if (!userId && !endUserId) {
    throw new Error("setUserFlowProviderOverride: exactly one of userId or endUserId must be set");
  }

  // Atomic upsert — partial unique indexes (idx_ufpp_member / idx_ufpp_end_user)
  // cannot be targeted by Drizzle's onConflictDoUpdate, so we use raw SQL.
  await db.execute(sql`
    INSERT INTO user_flow_provider_profiles (user_id, end_user_id, package_id, provider_id, profile_id, updated_at)
    VALUES (${userId}, ${endUserId}, ${packageId}, ${providerId}, ${profileId}, NOW())
    ON CONFLICT (${userId !== null ? sql`user_id` : sql`end_user_id`}, package_id, provider_id)
      WHERE ${userId !== null ? sql`user_id IS NOT NULL` : sql`end_user_id IS NOT NULL`}
    DO UPDATE SET profile_id = EXCLUDED.profile_id, updated_at = NOW()
  `);
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
 * Resolve actor profile context for a flow: default profile + per-provider overrides.
 * Used by execution, flow-detail, and internal (sidecar credential proxy) routes.
 *
 * When actor is null (e.g. sidecar with no user), pass fallbackProfileId to skip
 * ensureDefaultProfile and per-provider overrides.
 */
export async function resolveActorProfileContext(
  actor: Actor | null,
  packageId: string,
  fallbackProfileId: string | null = null,
): Promise<{ defaultUserProfileId: string | null; userProviderOverrides: Record<string, string> }> {
  if (!actor) {
    return {
      defaultUserProfileId: fallbackProfileId,
      userProviderOverrides: {},
    };
  }
  const [defaultUserProfileId, userProviderOverrides] = await Promise.all([
    getDefaultProfileId(actor),
    getUserFlowProviderOverrides(actor, packageId),
  ]);
  return { defaultUserProfileId, userProviderOverrides };
}

/**
 * Get a profile by ID without actor/org scoping. Used by scheduler to load the
 * profile referenced by a schedule's connectionProfileId.
 *
 * No orgId filter: user/end-user profiles have orgId=null on the row, so filtering
 * by orgId would miss them. The caller (scheduler) already validates the schedule
 * belongs to the requesting org.
 */
export async function getProfileByIdUnsafe(profileId: string): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(eq(connectionProfiles.id, profileId))
    .limit(1);
  return row ?? null;
}

// ─── Schedule Profile Resolution ────────────────────────────

/**
 * Determine how to pass a schedule's connectionProfileId to resolveProviderProfiles
 * based on whether the profile is an org profile or a user profile.
 *
 * - Org profile → passed as orgProfileId (bindings loaded), no user fallback
 * - User profile → passed as defaultUserProfileId, flowOrgProfileId as org fallback
 */
export function resolveScheduleProfileArgs(
  profile: ConnectionProfile,
  connectionProfileId: string,
  flowOrgProfileId?: string | null,
): { defaultUserProfileId: string | null; orgProfileId: string | null } {
  const isOrgProfile = !!profile.orgId;
  return {
    defaultUserProfileId: isOrgProfile ? null : connectionProfileId,
    orgProfileId: isOrgProfile ? connectionProfileId : (flowOrgProfileId ?? null),
  };
}

// ─── Provider Profile Resolution ────────────────────────────

/** Dependencies for resolveProviderProfiles — injectable for testing. */
export interface ResolveProviderProfilesDeps {
  getOrgProfileBindings: (orgProfileId: string, orgId: string) => Promise<Record<string, string>>;
}

const defaultResolveProviderProfilesDeps: ResolveProviderProfilesDeps = {
  getOrgProfileBindings,
};

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
  defaultUserProfileId: string | null,
  userProviderOverrides?: Record<string, string>,
  orgProfileId?: string | null,
  orgId?: string,
  deps: ResolveProviderProfilesDeps = defaultResolveProviderProfilesDeps,
): Promise<ProviderProfileMap> {
  const map: ProviderProfileMap = {};

  // Load org bindings if an org profile is provided
  let bindings: Record<string, string> = {};
  if (orgProfileId && orgId) {
    bindings = await deps.getOrgProfileBindings(orgProfileId, orgId);
  }

  for (const svc of providers) {
    const orgBinding = orgProfileId ? bindings[svc.id] : undefined;
    if (orgBinding) {
      map[svc.id] = { profileId: orgBinding, source: "org_binding" };
    } else {
      const fallbackId = userProviderOverrides?.[svc.id] ?? defaultUserProfileId;
      if (fallbackId) {
        map[svc.id] = { profileId: fallbackId, source: "user_profile" };
      }
      // If no fallback (org-only mode), provider simply not in map — dependency validation will catch it
    }
  }

  return map;
}
