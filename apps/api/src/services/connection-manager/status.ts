import { inArray, and, eq, or, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionProfiles, userProviderConnections } from "@appstrate/db/schema";
import { batchLoadUserNames } from "../../lib/user-helpers.ts";
import type { FlowProviderRequirement, ProviderProfileMap } from "../../types/index.ts";
import type { ProviderStatus, ConnectionStatusValue } from "@appstrate/shared-types";
import { getConnection, validateScopes, listProviders } from "@appstrate/connect";
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
): Promise<ConnectionStatus> {
  const conn = await getConnection(db, connectionProfileId, provider, orgId);
  if (conn) {
    return {
      provider,
      status: "connected",
      connectionId: conn.id,
      connectedAt: conn.createdAt,
      scopesGranted: conn.scopesGranted,
    };
  }
  return { provider, status: "not_connected" };
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
 * Returns a Map keyed by "profileId:providerId" → connection row.
 */
async function batchGetConnectionStatuses(
  profileIds: string[],
  orgId: string,
): Promise<Map<string, { id: string; createdAt: string; scopesGranted: string[] | null }>> {
  if (profileIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: userProviderConnections.id,
      profileId: userProviderConnections.profileId,
      providerId: userProviderConnections.providerId,
      createdAt: userProviderConnections.createdAt,
      scopesGranted: userProviderConnections.scopesGranted,
    })
    .from(userProviderConnections)
    .where(
      and(
        inArray(userProviderConnections.profileId, profileIds),
        eq(userProviderConnections.orgId, orgId),
      ),
    );

  const map = new Map<string, { id: string; createdAt: string; scopesGranted: string[] | null }>();
  for (const row of rows) {
    const key = `${row.profileId}:${row.providerId}`;
    map.set(key, {
      id: row.id,
      createdAt: toISORequired(row.createdAt) || toISORequired(new Date()),
      scopesGranted: row.scopesGranted,
    });
  }
  return map;
}

/**
 * Resolve provider statuses for a flow's required providers.
 * providerProfiles maps each providerId to the profile holding its credentials
 * (already resolved via org profile bindings or user profile direct).
 */
export async function resolveProviderStatuses(
  providers: FlowProviderRequirement[],
  providerProfiles: ProviderProfileMap,
  orgId: string,
): Promise<ProviderStatus[]> {
  const profileIds = [
    ...new Set(
      Object.values(providerProfiles)
        .map((e) => e.profileId)
        .filter(Boolean),
    ),
  ];

  // Batch-fetch profile info, connection statuses, and auth modes in parallel
  const [profileInfoMap, connectionMap, allProviders] = await Promise.all([
    buildProfileInfoMap(profileIds, orgId),
    batchGetConnectionStatuses(profileIds, orgId),
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
      const connStatus: ConnectionStatusValue = conn ? "connected" : "not_connected";

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
