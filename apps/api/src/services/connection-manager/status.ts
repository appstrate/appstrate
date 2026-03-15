import { db } from "../../lib/db.ts";
import type { FlowProviderRequirement } from "../../types/index.ts";
import type { ProviderStatus } from "@appstrate/shared-types";
import { getConnection, validateScopes } from "@appstrate/connect";
import { getProviderAuthMode } from "./providers.ts";
import { authModeLabel } from "./helpers.ts";

export interface ConnectionStatus {
  provider: string;
  status: "connected" | "not_connected" | "needs_reconnection";
  connectionId?: string;
  connectedAt?: string;
  scopesGranted?: string[];
}

export async function getConnectionStatus(
  provider: string,
  profileId: string,
  orgId: string,
): Promise<ConnectionStatus> {
  const conn = await getConnection(db, profileId, provider, orgId);
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
 * Uses profileId for both user and admin connections (via providerProfiles map).
 */
export async function resolveProviderStatuses(
  providers: FlowProviderRequirement[],
  adminConns: Record<string, string>,
  orgId: string,
  userProfileId?: string,
): Promise<ProviderStatus[]> {
  return Promise.all(
    providers.map(async (svc) => {
      const mode = svc.connectionMode ?? "user";
      const base = {
        id: svc.id,
        provider: svc.provider,
        description: svc.description ?? "",
      };

      const authMode = await getProviderAuthMode(svc.provider, orgId);
      const label = authModeLabel(authMode);
      const scopesRequired = svc.scopes?.length ? svc.scopes : undefined;

      if (mode === "admin") {
        const adminProfileId = adminConns[svc.id];
        if (adminProfileId) {
          const conn = await getConnectionStatus(svc.provider, adminProfileId, orgId);
          return {
            ...base,
            status: conn.status,
            authMode: label,
            connectionMode: "admin" as const,
            adminProvided: true,
            ...buildScopeInfo(conn.scopesGranted, scopesRequired, conn.status === "connected"),
          };
        }
        return {
          ...base,
          status: "not_connected" as const,
          authMode: label,
          connectionMode: "admin" as const,
          adminProvided: false,
          ...(scopesRequired ? { scopesRequired } : {}),
        };
      }

      const conn = userProfileId
        ? await getConnectionStatus(svc.provider, userProfileId, orgId)
        : { status: "not_connected" as const };
      const connScopesGranted = "scopesGranted" in conn ? conn.scopesGranted : undefined;
      return {
        ...base,
        status: conn.status,
        authMode: label,
        connectionMode: "user" as const,
        ...buildScopeInfo(connScopesGranted, scopesRequired, conn.status === "connected"),
      };
    }),
  );
}
