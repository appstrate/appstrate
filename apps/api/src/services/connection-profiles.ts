// SPDX-License-Identifier: Apache-2.0

/**
 * Connection Profiles — manages actor and app connection profiles and profile resolution.
 */

import { eq, and, count, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionProfiles,
  userAgentProviderProfiles,
  userProviderConnections,
  appProfileProviderBindings,
  organizationMembers,
  applicationPackages,
} from "@appstrate/db/schema";
import type { ConnectionProfile } from "@appstrate/db/schema";
import { type Actor, actorInsert, actorFilter } from "../lib/actor.ts";
import { getAppProfileBindings } from "./state/index.ts";
import { getPackageConfig } from "./application-packages.ts";
import type { AgentProviderRequirement, ProviderProfileMap } from "../types/index.ts";
import { notFound, invalidRequest } from "../lib/errors.ts";
import type { AppScope } from "../lib/scope.ts";

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
      applicationId: connectionProfiles.applicationId,
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
 * or an app profile belonging to the actor's current application.
 */
export async function getAccessibleProfile(
  profileId: string,
  actor: Actor,
  scope: AppScope,
): Promise<ConnectionProfile | null> {
  return (await getProfileForActor(profileId, actor)) ?? (await getAppProfile(scope, profileId));
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

// ─── App Profile CRUD ───────────────────────────────────────

export async function listAppProfiles(
  scope: AppScope,
): Promise<(ConnectionProfile & { bindingCount: number; boundProviderIds: string[] })[]> {
  // Fetch profiles
  const profileRows = await db
    .select()
    .from(connectionProfiles)
    .where(eq(connectionProfiles.applicationId, scope.applicationId));

  if (profileRows.length === 0) return [];

  // Fetch all bindings for these profiles in a single query
  const profileIds = profileRows.map((p) => p.id);
  const bindingRows = await db
    .select({
      appProfileId: appProfileProviderBindings.appProfileId,
      providerId: appProfileProviderBindings.providerId,
    })
    .from(appProfileProviderBindings)
    .where(inArray(appProfileProviderBindings.appProfileId, profileIds));

  // Group bindings by profile
  const bindingsByProfile = new Map<string, string[]>();
  for (const row of bindingRows) {
    const list = bindingsByProfile.get(row.appProfileId) ?? [];
    list.push(row.providerId);
    bindingsByProfile.set(row.appProfileId, list);
  }

  return profileRows.map((p) => {
    const providerIds = bindingsByProfile.get(p.id) ?? [];
    return { ...p, bindingCount: providerIds.length, boundProviderIds: providerIds };
  });
}

export async function createAppProfile(scope: AppScope, name: string): Promise<ConnectionProfile> {
  const [created] = await db
    .insert(connectionProfiles)
    .values({ applicationId: scope.applicationId, name, isDefault: false })
    .returning();
  return created!;
}

export async function getAppProfile(
  scope: AppScope,
  profileId: string,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        eq(connectionProfiles.applicationId, scope.applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Load the app profile configured on an agent, returning null if none configured
 * or if the referenced profile was deleted.
 */
export async function getAgentAppProfile(
  scope: AppScope,
  packageId: string,
): Promise<{ id: string; name: string } | null> {
  const { appProfileId } = await getPackageConfig(scope.applicationId, packageId);
  if (!appProfileId) return null;
  const profile = await getAppProfile(scope, appProfileId);
  return profile ? { id: appProfileId, name: profile.name } : null;
}

export async function renameAppProfile(
  scope: AppScope,
  profileId: string,
  name: string,
): Promise<void> {
  const [updated] = await db
    .update(connectionProfiles)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        eq(connectionProfiles.applicationId, scope.applicationId),
      ),
    )
    .returning({ id: connectionProfiles.id });

  if (!updated) throw notFound("Profile not found");
}

export async function deleteAppProfile(scope: AppScope, profileId: string): Promise<void> {
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        eq(connectionProfiles.applicationId, scope.applicationId),
      ),
    )
    .limit(1);

  if (!profile) throw notFound("Profile not found");

  // Clear stale appProfileId references in application_packages before deleting the profile.
  // The FK has onDelete: "set null", but we clear explicitly as defense-in-depth.
  await db
    .update(applicationPackages)
    .set({ appProfileId: null, updatedAt: new Date() })
    .where(eq(applicationPackages.appProfileId, profileId));

  await db
    .delete(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        eq(connectionProfiles.applicationId, scope.applicationId),
      ),
    );
}

/**
 * List app profiles where a specific user has active bindings.
 * Used to show users which app profiles depend on their credentials.
 */
export async function listAppProfilesWithUserBindings(
  scope: AppScope,
  userId: string,
): Promise<{ profile: ConnectionProfile; providerIds: string[] }[]> {
  const rows = await db
    .select({
      appProfileId: appProfileProviderBindings.appProfileId,
      providerId: appProfileProviderBindings.providerId,
      profileName: connectionProfiles.name,
      profileCreatedAt: connectionProfiles.createdAt,
      profileUpdatedAt: connectionProfiles.updatedAt,
    })
    .from(appProfileProviderBindings)
    .innerJoin(
      connectionProfiles,
      eq(connectionProfiles.id, appProfileProviderBindings.appProfileId),
    )
    .where(
      and(
        eq(appProfileProviderBindings.boundByUserId, userId),
        eq(connectionProfiles.applicationId, scope.applicationId),
      ),
    );

  const grouped = new Map<
    string,
    { profileName: string; createdAt: Date; updatedAt: Date; providerIds: string[] }
  >();
  for (const row of rows) {
    const entry = grouped.get(row.appProfileId) ?? {
      profileName: row.profileName,
      createdAt: row.profileCreatedAt,
      updatedAt: row.profileUpdatedAt,
      providerIds: [],
    };
    entry.providerIds.push(row.providerId);
    grouped.set(row.appProfileId, entry);
  }

  return Array.from(grouped.entries()).map(([profileId, data]) => ({
    profile: {
      id: profileId,
      userId: null,
      endUserId: null,
      applicationId: scope.applicationId,
      name: data.profileName,
      isDefault: false,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    },
    providerIds: data.providerIds,
  }));
}

// ─── Per-Provider Profile Overrides ──────────────────────────

/** Get all per-provider profile overrides for an actor+agent combination. */
export async function getUserAgentProviderOverrides(
  actor: Actor,
  packageId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      providerId: userAgentProviderProfiles.providerId,
      profileId: userAgentProviderProfiles.profileId,
    })
    .from(userAgentProviderProfiles)
    .where(
      and(
        actorFilter(actor, {
          userId: userAgentProviderProfiles.userId,
          endUserId: userAgentProviderProfiles.endUserId,
        }),
        eq(userAgentProviderProfiles.packageId, packageId),
      ),
    );

  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.providerId] = row.profileId;
  }
  return map;
}

/** Set a per-provider profile override (atomic upsert via raw SQL). */
export async function setUserAgentProviderOverride(
  actor: Actor,
  packageId: string,
  providerId: string,
  profileId: string,
): Promise<void> {
  const actorValues = actorInsert(actor);
  const userId = actorValues.userId ?? null;
  const endUserId = actorValues.endUserId ?? null;

  if (!userId && !endUserId) {
    throw new Error("setUserAgentProviderOverride: exactly one of userId or endUserId must be set");
  }

  // Atomic upsert — partial unique indexes (idx_ufpp_member / idx_ufpp_end_user)
  // cannot be targeted by Drizzle's onConflictDoUpdate, so we use raw SQL.
  await db.execute(sql`
    INSERT INTO user_agent_provider_profiles (user_id, end_user_id, package_id, provider_id, profile_id, updated_at)
    VALUES (${userId}, ${endUserId}, ${packageId}, ${providerId}, ${profileId}, NOW())
    ON CONFLICT (${userId !== null ? sql`user_id` : sql`end_user_id`}, package_id, provider_id)
      WHERE ${userId !== null ? sql`user_id IS NOT NULL` : sql`end_user_id IS NOT NULL`}
    DO UPDATE SET profile_id = EXCLUDED.profile_id, updated_at = NOW()
  `);
}

/** Remove a per-provider profile override (revert to default). */
export async function removeUserAgentProviderOverride(
  actor: Actor,
  packageId: string,
  providerId: string,
): Promise<void> {
  await db.delete(userAgentProviderProfiles).where(
    and(
      actorFilter(actor, {
        userId: userAgentProviderProfiles.userId,
        endUserId: userAgentProviderProfiles.endUserId,
      }),
      eq(userAgentProviderProfiles.packageId, packageId),
      eq(userAgentProviderProfiles.providerId, providerId),
    ),
  );
}

/** Get the default profile ID for an actor. */
export async function getDefaultProfileId(actor: Actor): Promise<string> {
  return (await ensureDefaultProfile(actor)).id;
}

/**
 * Resolve actor profile context for an agent: default profile + per-provider overrides.
 * Used by runs, agent-detail, and internal (sidecar credential proxy) routes.
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
    getUserAgentProviderOverrides(actor, packageId),
  ]);
  return { defaultUserProfileId, userProviderOverrides };
}

/**
 * Get a profile by ID without actor/org scoping. Used by scheduler to load the
 * profile referenced by a schedule's connectionProfileId.
 *
 * No applicationId filter: user/end-user profiles have applicationId=null on the row, so filtering
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
 * based on whether the profile is an app profile or a user profile.
 *
 * - App profile → passed as appProfileId (bindings loaded), no user fallback
 * - User profile → passed as defaultUserProfileId, agentAppProfileId as app fallback
 */
export function resolveScheduleProfileArgs(
  profile: ConnectionProfile,
  connectionProfileId: string,
  agentAppProfileId?: string | null,
): { defaultUserProfileId: string | null; appProfileId: string | null } {
  const isAppProfile = !!profile.applicationId;
  return {
    defaultUserProfileId: isAppProfile ? null : connectionProfileId,
    appProfileId: isAppProfile ? connectionProfileId : (agentAppProfileId ?? null),
  };
}

// ─── Provider Profile Resolution ────────────────────────────

/** Dependencies for resolveProviderProfiles — injectable for testing. */
export interface ResolveProviderProfilesDeps {
  getAppProfileBindings: (
    appProfileId: string,
    applicationId: string,
  ) => Promise<Record<string, string>>;
}

const defaultResolveProviderProfilesDeps: ResolveProviderProfilesDeps = {
  getAppProfileBindings,
};

/**
 * Resolve profile IDs for each provider in a package.
 *
 * Three-layer resolution (highest priority first):
 * 1. appProfileId binding → source: "app_binding"
 * 2. Per-provider user override → source: "user_profile"
 * 3. Default user profile → source: "user_profile"
 *
 * For schedules: pass the schedule's connectionProfileId as defaultUserProfileId
 * with appProfileId if the schedule uses an app profile. No per-provider overrides.
 */
export async function resolveProviderProfiles(
  providers: AgentProviderRequirement[],
  defaultUserProfileId: string | null,
  userProviderOverrides?: Record<string, string>,
  appProfileId?: string | null,
  applicationId?: string,
  deps: ResolveProviderProfilesDeps = defaultResolveProviderProfilesDeps,
): Promise<ProviderProfileMap> {
  const map: ProviderProfileMap = {};

  // Load app bindings if an app profile is provided
  let bindings: Record<string, string> = {};
  if (appProfileId && applicationId) {
    bindings = await deps.getAppProfileBindings(appProfileId, applicationId);
  }

  for (const svc of providers) {
    const appBinding = appProfileId ? bindings[svc.id] : undefined;
    if (appBinding) {
      map[svc.id] = { profileId: appBinding, source: "app_binding" };
    } else {
      const fallbackId = userProviderOverrides?.[svc.id] ?? defaultUserProfileId;
      if (fallbackId) {
        map[svc.id] = { profileId: fallbackId, source: "user_profile" };
      }
      // If no fallback (app-only mode), provider simply not in map — dependency validation will catch it
    }
  }

  return map;
}
