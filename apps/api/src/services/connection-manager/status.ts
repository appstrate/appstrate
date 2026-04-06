// SPDX-License-Identifier: Apache-2.0

import { inArray, and, eq, or, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionProfiles, userProviderConnections } from "@appstrate/db/schema";
import { batchLoadUserNames } from "../../lib/user-helpers.ts";
import type { AgentProviderRequirement, ProviderProfileMap } from "../../types/index.ts";
import type { ProviderStatus, ConnectionStatusValue } from "@appstrate/shared-types";
import {
  getConnection,
  getProviderCredentialId,
  validateScopes,
  listProviders,
} from "@appstrate/connect";
import { authModeLabel } from "./helpers.ts";
import { toISORequired } from "../../lib/date-helpers.ts";

export interface ConnectionStatus {
  provider: string;
  status: ConnectionStatusValue;
  connectionId?: string;
  connectedAt?: string;
  scopesGranted?: string[];
}

export async function getConnectionStatus(
  provider: string,
  connectionProfileId: string,
  orgId: string,
  providerCredentialId: string,
): Promise<ConnectionStatus> {
  const conn = await getConnection(db, connectionProfileId, provider, orgId, providerCredentialId);
  if (conn) {
    return {
      provider,
      status: conn.needsReconnection ? "needs_reconnection" : "connected",
      connectionId: conn.id,
      connectedAt: conn.createdAt,
      scopesGranted: conn.scopesGranted,
    };
  }
  return { provider, status: "not_connected" };
}

/**
 * Check if any active connection exists for a provider on a profile (regardless of application).
 * Used for org profile binding validation — intentionally not app-scoped.
 */
export async function hasActiveConnection(
  provider: string,
  connectionProfileId: string,
  orgId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: userProviderConnections.id })
    .from(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.profileId, connectionProfileId),
        eq(userProviderConnections.providerId, provider),
        eq(userProviderConnections.orgId, orgId),
        eq(userProviderConnections.needsReconnection, false),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Build scope validation info for a connection. */
function buildScopeInfo(
  scopesGranted: string[] | undefined,
  scopesRequired: string[] | undefined,
  isConnected: boolean,
): Record<string, unknown> {
  if (!scopesRequired) return {};
  if (!isConnected || !scopesGranted) return { scopesRequired };

  const result = validateScopes(scopesGranted, scopesRequired);
  return {
    scopesRequired,
    scopesGranted: result.granted,
    scopesSufficient: result.sufficient,
    scopesMissing: result.missing.length > 0 ? result.missing : undefined,
  };
}

/**
 * Batch-fetch profile name + owner name for a set of profile IDs.
 *
 * Defense-in-depth: filters by orgId to ensure only profiles belonging to the
 * org (or user-owned profiles with orgId=null) are returned, even though
 * profileIds already come from org-scoped queries via resolveProviderProfiles().
 */
async function buildProfileInfoMap(
  profileIds: string[],
  orgId: string,
): Promise<Map<string, { profileName: string | null; profileOwnerName: string | null }>> {
  if (profileIds.length === 0) {
    return new Map();
  }

  const profileRows = await db
    .select({
      id: connectionProfiles.id,
      name: connectionProfiles.name,
      userId: connectionProfiles.userId,
    })
    .from(connectionProfiles)
    .where(
      and(
        inArray(connectionProfiles.id, profileIds),
        or(eq(connectionProfiles.orgId, orgId), isNull(connectionProfiles.orgId)),
      ),
    );

  const userIds = profileRows.map((r) => r.userId).filter((id): id is string => id != null);
  const userNameMap = await batchLoadUserNames(userIds);

  return new Map(
    profileRows.map((row) => {
      const ownerName = row.userId ? (userNameMap.get(row.userId) ?? null) : null;
      return [row.id, { profileName: row.name, profileOwnerName: ownerName }];
    }),
  );
}

/**
 * Batch-fetch connection statuses for all (profileId, orgId) pairs in a single query.
 * Filters by providerCredentialId when available to ensure per-app isolation.
 * Returns a Map keyed by "profileId:providerId" → connection row.
 */
async function batchGetConnectionStatuses(
  profileIds: string[],
  orgId: string,
  credentialIdMap: Map<string, string>,
): Promise<
  Map<
    string,
    { id: string; createdAt: string; scopesGranted: string[] | null; needsReconnection: boolean }
  >
> {
  if (profileIds.length === 0) return new Map();

  const conditions = [
    inArray(userProviderConnections.profileId, profileIds),
    eq(userProviderConnections.orgId, orgId),
  ];

  // Filter to only connections created with the application's credentials.
  // If no credentials are configured for any provider, return empty — no connections can exist.
  const credentialIds = [...credentialIdMap.values()];
  if (credentialIds.length === 0) return new Map();
  conditions.push(inArray(userProviderConnections.providerCredentialId, credentialIds));

  const rows = await db
    .select({
      id: userProviderConnections.id,
      profileId: userProviderConnections.profileId,
      providerId: userProviderConnections.providerId,
      createdAt: userProviderConnections.createdAt,
      scopesGranted: userProviderConnections.scopesGranted,
      needsReconnection: userProviderConnections.needsReconnection,
    })
    .from(userProviderConnections)
    .where(and(...conditions));

  const map = new Map<
    string,
    { id: string; createdAt: string; scopesGranted: string[] | null; needsReconnection: boolean }
  >();
  for (const row of rows) {
    const key = `${row.profileId}:${row.providerId}`;
    map.set(key, {
      id: row.id,
      createdAt: toISORequired(row.createdAt) || toISORequired(new Date()),
      scopesGranted: row.scopesGranted,
      needsReconnection: row.needsReconnection,
    });
  }
  return map;
}

/**
 * Resolve provider statuses for an agent's required providers.
 * providerProfiles maps each providerId to the profile holding its credentials
 * (already resolved via org profile bindings or user profile direct).
 * applicationId is required to resolve per-app provider credentials.
 */
export async function resolveProviderStatuses(
  providers: AgentProviderRequirement[],
  providerProfiles: ProviderProfileMap,
  orgId: string,
  applicationId: string,
): Promise<ProviderStatus[]> {
  const profileIds = [
    ...new Set(
      Object.values(providerProfiles)
        .map((e) => e.profileId)
        .filter(Boolean),
    ),
  ];

  // Resolve providerCredentialId for each provider in this application
  const credentialIdMap = new Map<string, string>();
  const providerIds = [...new Set(providers.map((p) => p.id))];
  await Promise.all(
    providerIds.map(async (providerId) => {
      const credId = await getProviderCredentialId(db, applicationId, providerId);
      if (credId) credentialIdMap.set(providerId, credId);
    }),
  );

  // Batch-fetch profile info, connection statuses, and auth modes in parallel
  const [profileInfoMap, connectionMap, allProviders] = await Promise.all([
    buildProfileInfoMap(profileIds, orgId),
    batchGetConnectionStatuses(profileIds, orgId, credentialIdMap),
    listProviders(db, orgId),
  ]);

  // Build auth mode lookup from batch-fetched providers
  const authModeMap = new Map<string, string | undefined>();
  for (const p of allProviders) {
    authModeMap.set(p.id, p.authMode);
  }

  return providers.map((svc) => {
    const base = {
      id: svc.id,
      provider: svc.id,
      description: svc.description ?? "",
    };

    const authMode = authModeMap.get(svc.id);
    const label = authModeLabel(authMode);
    const scopesRequired = svc.scopes?.length ? svc.scopes : undefined;
    const entry = providerProfiles[svc.id];

    if (!entry) {
      return {
        ...base,
        status: "not_connected" as const,
        authMode: label,
        source: null,
        profileName: null,
        profileOwnerName: null,
        ...(scopesRequired ? { scopesRequired } : {}),
      };
    }

    // Look up connection from batch-fetched map
    const connKey = `${entry.profileId}:${svc.id}`;
    const conn = connectionMap.get(connKey);
    const connStatus: ConnectionStatusValue = conn
      ? conn.needsReconnection
        ? "needs_reconnection"
        : "connected"
      : "not_connected";

    const profileInfo = profileInfoMap.get(entry.profileId) ?? {
      profileName: null,
      profileOwnerName: null,
    };
    const connScopesGranted = conn?.scopesGranted ?? undefined;
    return {
      ...base,
      status: connStatus,
      authMode: label,
      source: entry.source,
      profileName: profileInfo.profileName,
      profileOwnerName: profileInfo.profileOwnerName,
      ...buildScopeInfo(connScopesGranted, scopesRequired, connStatus === "connected"),
    };
  });
}
