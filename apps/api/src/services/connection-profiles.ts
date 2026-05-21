// SPDX-License-Identifier: Apache-2.0

/**
 * Connection Profiles — manages actor and app connection profiles and profile resolution.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionProfiles,
  userApplicationProfiles,
  organizationMembers,
  applicationPackages,
} from "@appstrate/db/schema";
import type { ConnectionProfile } from "@appstrate/db/schema";
import { type Actor, actorInsert, actorFilter } from "../lib/actor.ts";
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
    .select()
    .from(connectionProfiles)
    .where(actorFilter(actor, PROFILE_ACTOR_COLUMNS));

  return rows.map((p) => ({ ...p, connectionCount: 0 }));
}

/**
 * Get a single profile by ID, scoped to the actor. Returns null if not found.
 */
export async function getProfileForActor(
  connectionProfileId: string,
  actor: Actor,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
        actorFilter(actor, PROFILE_ACTOR_COLUMNS),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Check if an actor can use a profile: either their own (user/end-user)
 * or an app profile belonging to the actor's current application.
 */
export async function getAccessibleProfile(
  connectionProfileId: string,
  actor: Actor,
  scope: AppScope,
): Promise<ConnectionProfile | null> {
  return (
    (await getProfileForActor(connectionProfileId, actor)) ??
    (await getAppProfile(scope, connectionProfileId))
  );
}

/**
 * Get a user profile whose owner is a member of the given org.
 * Used for read-only access (e.g. viewing schedule provider status).
 */
export async function getOrgMemberProfile(
  connectionProfileId: string,
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
    .where(eq(connectionProfiles.id, connectionProfileId))
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

export async function renameProfile(
  connectionProfileId: string,
  actor: Actor,
  name: string,
): Promise<void> {
  const [updated] = await db
    .update(connectionProfiles)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
        actorFilter(actor, PROFILE_ACTOR_COLUMNS),
      ),
    )
    .returning({ id: connectionProfiles.id });

  if (!updated) throw notFound("Profile not found");
}

export async function deleteProfile(connectionProfileId: string, actor: Actor): Promise<void> {
  // Check it's not the default
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
        actorFilter(actor, PROFILE_ACTOR_COLUMNS),
      ),
    )
    .limit(1);

  if (!profile) throw notFound("Profile not found");
  if (profile.isDefault) throw invalidRequest("Cannot delete the default profile");

  await db
    .delete(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
        actorFilter(actor, PROFILE_ACTOR_COLUMNS),
      ),
    );
}

// ─── App Profile CRUD ───────────────────────────────────────

export async function listAppProfiles(
  scope: AppScope,
): Promise<(ConnectionProfile & { bindingCount: number; boundProviderIds: string[] })[]> {
  const profileRows = await db
    .select()
    .from(connectionProfiles)
    .where(eq(connectionProfiles.applicationId, scope.applicationId));

  return profileRows.map((p) => ({ ...p, bindingCount: 0, boundProviderIds: [] }));
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
  connectionProfileId: string,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
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
  connectionProfileId: string,
  name: string,
): Promise<void> {
  const [updated] = await db
    .update(connectionProfiles)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
        eq(connectionProfiles.applicationId, scope.applicationId),
      ),
    )
    .returning({ id: connectionProfiles.id });

  if (!updated) throw notFound("Profile not found");
}

export async function deleteAppProfile(
  scope: AppScope,
  connectionProfileId: string,
): Promise<void> {
  const [profile] = await db
    .select()
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
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
    .where(eq(applicationPackages.appProfileId, connectionProfileId));

  await db
    .delete(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, connectionProfileId),
        eq(connectionProfiles.applicationId, scope.applicationId),
      ),
    );
}

/**
 * List app profiles where a specific user has active bindings.
 * Used to show users which app profiles depend on their credentials.
 */
export async function listAppProfilesWithUserBindings(
  _scope: AppScope,
  _userId: string,
): Promise<{ profile: ConnectionProfile; providerIds: string[] }[]> {
  // Provider bindings were removed with the provider package type.
  return [];
}

/** Get the default profile ID for an actor. */
export async function getDefaultProfileId(actor: Actor): Promise<string> {
  return (await ensureDefaultProfile(actor)).id;
}

/**
 * Resolve actor profile context for an agent: default profile + per-provider overrides.
 * Used by runs, agent-detail, and internal (sidecar credential proxy) routes.
 *
 * When `applicationId` is supplied for a member actor, the per-(member, application)
 * sticky default — if set via `PUT /api/me/application-profile` — wins over the
 * member's auto-created Default profile, mirroring the cascade in
 * `credential-proxy.ts:resolveProfileId`. This keeps the dashboard preflight
 * source field consistent with what the sidecar will actually use at run time.
 *
 * When actor is null (e.g. sidecar with no user), pass fallbackProfileId to skip
 * ensureDefaultProfile and per-provider overrides.
 */
export async function resolveActorProfileContext(
  actor: Actor | null,
  _packageId: string,
  fallbackProfileId: string | null = null,
  applicationId?: string,
): Promise<{ defaultUserProfileId: string | null; userProviderOverrides: Record<string, string> }> {
  if (!actor) {
    return {
      defaultUserProfileId: fallbackProfileId,
      userProviderOverrides: {},
    };
  }
  const stickyPromise: Promise<string | null> =
    actor.type === "user" && applicationId
      ? getMemberApplicationProfileId(actor.id, applicationId)
      : Promise.resolve(null);
  const [sticky, fallback] = await Promise.all([stickyPromise, getDefaultProfileId(actor)]);
  return { defaultUserProfileId: sticky ?? fallback, userProviderOverrides: {} };
}

/**
 * Get a profile by ID without actor/org scoping. Used by scheduler to load the
 * profile referenced by a schedule's connectionProfileId.
 *
 * No applicationId filter: user/end-user profiles have applicationId=null on the row, so filtering
 * by orgId would miss them. The caller (scheduler) already validates the schedule
 * belongs to the requesting org.
 */
export async function getProfileByIdUnsafe(
  connectionProfileId: string,
): Promise<ConnectionProfile | null> {
  const [row] = await db
    .select()
    .from(connectionProfiles)
    .where(eq(connectionProfiles.id, connectionProfileId))
    .limit(1);
  return row ?? null;
}

// ─── Per-(member, application) sticky default profile ────────

/**
 * Get the member's pinned default connection profile for an application,
 * if any. Returns `null` when no sticky is set — the caller's cascade
 * should fall through to the application default.
 */
export async function getMemberApplicationProfileId(
  userId: string,
  applicationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ connectionProfileId: userApplicationProfiles.connectionProfileId })
    .from(userApplicationProfiles)
    .where(
      and(
        eq(userApplicationProfiles.userId, userId),
        eq(userApplicationProfiles.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row?.connectionProfileId ?? null;
}

/**
 * Pin a connection profile as the member's default for the given
 * application. The profile must be one of:
 *   - a member-owned profile (`connection_profiles.user_id = userId`)
 *   - an app profile of the same application
 * Anything else is rejected with `invalidRequest` to prevent a member
 * from pinning another member's or another app's profile as their own
 * sticky.
 */
export async function setMemberApplicationProfileId(
  userId: string,
  applicationId: string,
  connectionProfileId: string,
): Promise<void> {
  const [row] = await db
    .select({
      userId: connectionProfiles.userId,
      applicationId: connectionProfiles.applicationId,
    })
    .from(connectionProfiles)
    .where(eq(connectionProfiles.id, connectionProfileId))
    .limit(1);
  if (!row) {
    throw notFound("profile");
  }
  const ownsAsMember = row.userId === userId;
  const ownsAsAppProfile = row.applicationId === applicationId;
  if (!ownsAsMember && !ownsAsAppProfile) {
    throw invalidRequest("Profile is not owned by the caller and not an app profile of this app");
  }
  await db
    .insert(userApplicationProfiles)
    .values({ userId, applicationId, connectionProfileId })
    .onConflictDoUpdate({
      target: [userApplicationProfiles.userId, userApplicationProfiles.applicationId],
      set: { connectionProfileId, updatedAt: new Date() },
    });
}

/**
 * Clear the member's per-app sticky. Idempotent — succeeds even when no
 * row exists. The cascade then falls through to the app default.
 */
export async function clearMemberApplicationProfile(
  userId: string,
  applicationId: string,
): Promise<void> {
  await db
    .delete(userApplicationProfiles)
    .where(
      and(
        eq(userApplicationProfiles.userId, userId),
        eq(userApplicationProfiles.applicationId, applicationId),
      ),
    );
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

/**
 * Resolve profile IDs for each provider in a package. The provider package
 * type was removed, so `providers` is always empty and the map is empty —
 * retained as a no-op stub for the run-pipeline callers that still pass a
 * (now-empty) provider list through their resolution step.
 */
export async function resolveProviderProfiles(
  providers: AgentProviderRequirement[],
  defaultUserProfileId: string | null,
  userProviderOverrides?: Record<string, string>,
  _appProfileId?: string | null,
  _applicationId?: string,
): Promise<ProviderProfileMap> {
  const map: ProviderProfileMap = {};
  for (const svc of providers) {
    const fallbackId = userProviderOverrides?.[svc.id] ?? defaultUserProfileId;
    if (fallbackId) {
      map[svc.id] = { connectionProfileId: fallbackId, source: "user_profile" };
    }
  }
  return map;
}
