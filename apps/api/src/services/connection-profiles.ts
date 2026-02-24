/**
 * Connection Profiles — manages user connection profiles and profile resolution.
 */

import { createHash } from "node:crypto";
import { eq, and, count } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { connectionProfiles, userFlowProfiles, serviceConnections } from "@appstrate/db/schema";
import type { ConnectionProfile } from "@appstrate/db/schema";
import { encrypt, type ProviderDefinition, type ProviderSnapshot } from "@appstrate/connect";
import { getAdminConnections } from "./state.ts";
import type { FlowServiceRequirement } from "../types/index.ts";

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
 * Get the effective profile ID for a user+flow combination.
 * Returns the override if one exists, otherwise the default.
 */
export async function getEffectiveProfileId(userId: string, flowId?: string): Promise<string> {
  if (flowId) {
    const [override] = await db
      .select({ profileId: userFlowProfiles.profileId })
      .from(userFlowProfiles)
      .where(and(eq(userFlowProfiles.userId, userId), eq(userFlowProfiles.flowId, flowId)))
      .limit(1);

    if (override) return override.profileId;
  }

  return getDefaultProfileId(userId);
}

export async function setFlowProfileOverride(
  userId: string,
  flowId: string,
  profileId: string,
): Promise<void> {
  await db
    .insert(userFlowProfiles)
    .values({ userId, flowId, profileId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userFlowProfiles.userId, userFlowProfiles.flowId],
      set: { profileId, updatedAt: new Date() },
    });
}

export async function removeFlowProfileOverride(userId: string, flowId: string): Promise<void> {
  await db
    .delete(userFlowProfiles)
    .where(and(eq(userFlowProfiles.userId, userId), eq(userFlowProfiles.flowId, flowId)));
}

// ─── Config Hash & Provider Snapshot ────────────────────────

/**
 * Compute a unified config hash for a provider definition.
 * Used to detect when provider config changes (requiring reconnection).
 */
export function computeConfigHash(provider: ProviderDefinition): string {
  const data = JSON.stringify({
    authMode: provider.authMode,
    clientId: provider.clientId ?? null,
    credentialSchema: provider.credentialSchema ?? null,
    credentialHeaderName: provider.credentialHeaderName ?? null,
    credentialHeaderPrefix: provider.credentialHeaderPrefix ?? null,
  });
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Build a provider snapshot for storage alongside the connection.
 * Encrypted fields (clientId/Secret) are stored encrypted within the snapshot.
 */
export function buildProviderSnapshot(provider: ProviderDefinition): ProviderSnapshot {
  return {
    authMode: provider.authMode,
    tokenUrl: provider.tokenUrl,
    refreshUrl: provider.refreshUrl,
    clientIdEncrypted: provider.clientId ? encrypt(provider.clientId) : undefined,
    clientSecretEncrypted: provider.clientSecret ? encrypt(provider.clientSecret) : undefined,
    scopeSeparator: provider.scopeSeparator,
    credentialFieldName: provider.credentialFieldName,
    credentialHeaderName: provider.credentialHeaderName,
    credentialHeaderPrefix: provider.credentialHeaderPrefix,
    authorizedUris: provider.authorizedUris,
    allowAllUris: provider.allowAllUris,
  };
}

// ─── Service Profile Resolution ─────────────────────────────

/**
 * Resolve profile IDs for each service in a flow.
 * Admin services get their profile from flow_admin_connections.
 * User services get the effective profile for the user+flow.
 */
export async function resolveServiceProfiles(
  services: FlowServiceRequirement[],
  userId: string,
  flowId: string,
  orgId: string,
): Promise<Record<string, string>> {
  const userProfileId = await getEffectiveProfileId(userId, flowId);
  const adminConns = await getAdminConnections(orgId, flowId);
  const map: Record<string, string> = {};

  for (const svc of services) {
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
