import { db } from "@appstrate/db/client";
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
      const connScopesGranted = "scopesGranted" in conn ? conn.scopesGranted : undefined;
      return {
        ...base,
        status: conn.status,
        authMode: label,
        source: entry.source,
        ...buildScopeInfo(connScopesGranted, scopesRequired, conn.status === "connected"),
      };
    }),
  );
}
