import { inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionProfiles, user } from "@appstrate/db/schema";
import type { FlowProviderRequirement, ProviderProfileMap } from "../../types/index.ts";
import type { ProviderStatus, ConnectionStatusValue } from "@appstrate/shared-types";
import { getConnection, validateScopes } from "@appstrate/connect";
import { getProviderAuthMode } from "./providers.ts";
import { authModeLabel } from "./helpers.ts";

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
 * Resolve provider statuses for a flow's required providers.
 * providerProfiles maps each providerId to the profile holding its credentials
 * (already resolved via org profile bindings or user profile direct).
 */
export async function resolveProviderStatuses(
  providers: FlowProviderRequirement[],
  providerProfiles: ProviderProfileMap,
  orgId: string,
): Promise<ProviderStatus[]> {
  // Batch-fetch all profile info in 1-2 queries instead of N
  const profileIds = [
    ...new Set(
      Object.values(providerProfiles)
        .map((e) => e.profileId)
        .filter(Boolean),
    ),
  ];

  let profileInfoMap = new Map<
    string,
    { profileName: string | null; profileOwnerName: string | null }
  >();

  if (profileIds.length > 0) {
    const profileRows = await db
      .select({
        id: connectionProfiles.id,
        name: connectionProfiles.name,
        userId: connectionProfiles.userId,
      })
      .from(connectionProfiles)
      .where(inArray(connectionProfiles.id, profileIds));

    const userIds = profileRows.map((r) => r.userId).filter((id): id is string => id != null);
    const userRows =
      userIds.length > 0
        ? await db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, userIds))
        : [];

    profileInfoMap = new Map(
      profileRows.map((row) => {
        const ownerName = row.userId
          ? (userRows.find((u) => u.id === row.userId)?.name ?? null)
          : null;
        return [row.id, { profileName: row.name, profileOwnerName: ownerName }];
      }),
    );
  }

  return Promise.all(
    providers.map(async (svc) => {
      const base = {
        id: svc.id,
        provider: svc.id,
        description: svc.description ?? "",
      };

      const authMode = await getProviderAuthMode(svc.id, orgId);
      const label = authModeLabel(authMode);
      const scopesRequired = svc.scopes?.length ? svc.scopes : undefined;
      const entry = providerProfiles[svc.id];

      if (!entry) {
        return {
          ...base,
          status: "not_connected" as const,
          authMode: label,
          ...(scopesRequired ? { scopesRequired } : {}),
        };
      }

      const conn = await getConnectionStatus(svc.id, entry.profileId, orgId);
      const profileInfo = profileInfoMap.get(entry.profileId) ?? {
        profileName: null,
        profileOwnerName: null,
      };
      const connScopesGranted = "scopesGranted" in conn ? conn.scopesGranted : undefined;
      return {
        ...base,
        status: conn.status,
        authMode: label,
        source: entry.source,
        profileName: profileInfo.profileName,
        profileOwnerName: profileInfo.profileOwnerName,
        ...buildScopeInfo(connScopesGranted, scopesRequired, conn.status === "connected"),
      };
    }),
  );
}
