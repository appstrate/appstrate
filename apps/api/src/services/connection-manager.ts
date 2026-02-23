/**
 * Connection Manager — thin service wrapper over @appstrate/connect.
 * Single source for connection operations.
 */

import { db } from "../lib/db.ts";
import { logger } from "../lib/logger.ts";
import type { FlowServiceRequirement } from "../types/index.ts";
import type { ServiceStatus } from "@appstrate/shared-types";
import { eq } from "drizzle-orm";
import { profiles } from "@appstrate/db/schema";

import {
  initiateOAuth,
  handleOAuthCallback,
  saveConnection,
  getConnection,
  listConnections as listConnectionsRaw,
  deleteConnection as deleteConnectionRaw,
  listProviders,
  getProviderAuthMode as getProviderAuthModeRaw,
  validateScopes,
  type ConnectionRecord,
  type ProviderDefinition,
  type InitiateOAuthResult,
  type OAuthCallbackResult,
  type ScopeValidationResult,
} from "@appstrate/connect";

// Re-export types for consumers
export type {
  ConnectionRecord,
  ProviderDefinition,
  InitiateOAuthResult,
  OAuthCallbackResult,
  ScopeValidationResult,
};

// ─── Connection Status ───────────────────────────────────────

export interface ConnectionStatus {
  provider: string;
  status: "connected" | "not_connected";
  connectionId?: string;
  connectedAt?: string;
  scopesGranted?: string[];
}

export async function getConnectionStatus(
  provider: string,
  orgId: string,
  userId: string,
): Promise<ConnectionStatus> {
  const conn = await getConnection(db, orgId, userId, provider);
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

// ─── OAuth Flow ──────────────────────────────────────────────

export async function initiateConnection(
  provider: string,
  orgId: string,
  userId: string,
  requestedScopes?: string[],
): Promise<{ authUrl: string; state: string }> {
  const redirectUri =
    process.env.OAUTH_CALLBACK_URL ??
    `http://localhost:${process.env.PORT || "3000"}/auth/callback`;
  return initiateOAuth(db, orgId, userId, provider, redirectUri, requestedScopes);
}

export async function handleCallback(code: string, state: string): Promise<OAuthCallbackResult> {
  const result = await handleOAuthCallback(db, code, state);

  // Save the connection
  await saveConnection(
    db,
    result.orgId,
    result.userId,
    result.providerId,
    "oauth2",
    {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
    },
    {
      scopesGranted: result.scopesGranted,
      expiresAt: result.expiresAt,
      rawTokenResponse: result.rawResponse,
    },
  );

  logger.info("OAuth connection established", {
    providerId: result.providerId,
    userId: result.userId,
    scopes: result.scopesGranted,
  });

  return result;
}

// ─── API Key Connection ──────────────────────────────────────

export async function saveApiKeyConnection(
  provider: string,
  apiKey: string,
  orgId: string,
  userId: string,
): Promise<void> {
  await saveConnection(db, orgId, userId, provider, "api_key", { api_key: apiKey });

  logger.info("API key connection saved", { provider, userId });
}

// ─── Generic Credentials Connection ──────────────────────────

export async function saveCredentialsConnection(
  provider: string,
  authMode: "basic" | "custom",
  credentials: Record<string, string>,
  orgId: string,
  userId: string,
): Promise<void> {
  await saveConnection(db, orgId, userId, provider, authMode, credentials);

  logger.info("Credentials connection saved", { provider, authMode, userId });
}

// ─── Connections List ────────────────────────────────────────

export async function listUserConnections(
  orgId: string,
  userId: string,
): Promise<ConnectionStatus[]> {
  const connections = await listConnectionsRaw(db, orgId, userId);
  return connections.map((c) => ({
    provider: c.providerId,
    status: "connected" as const,
    connectionId: c.id,
    connectedAt: c.createdAt,
    scopesGranted: c.scopesGranted,
  }));
}

// ─── Delete Connection ───────────────────────────────────────

export async function disconnectProvider(
  provider: string,
  orgId: string,
  userId: string,
): Promise<void> {
  await deleteConnectionRaw(db, orgId, userId, provider);
  logger.info("Connection deleted", { provider, userId });
}

// ─── Provider Info ───────────────────────────────────────────

export async function getProviderAuthMode(
  provider: string,
  orgId: string,
): Promise<string | undefined> {
  return getProviderAuthModeRaw(db, orgId, provider);
}

export interface IntegrationWithStatus {
  uniqueKey: string;
  provider: string;
  displayName: string;
  logo: string;
  status: "connected" | "not_connected";
  authMode?: string;
  connectionId?: string;
  connectedAt?: string;
}

/** Get user profile display name. */
async function getUserProfile(userId: string): Promise<{ display_name: string | null } | null> {
  const rows = await db
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (!rows[0]) return null;
  return { display_name: rows[0].displayName };
}

export async function getIntegrationsWithStatus(
  orgId: string,
  userId: string,
): Promise<IntegrationWithStatus[]> {
  const [providers, connections] = await Promise.all([
    listProviders(db, orgId),
    listConnectionsRaw(db, orgId, userId),
  ]);

  return providers.map((provider) => {
    const conn = connections.find((c) => c.providerId === provider.id);
    return {
      uniqueKey: provider.id,
      provider: provider.id,
      displayName: provider.displayName,
      logo: provider.iconUrl ?? "",
      status: conn ? ("connected" as const) : ("not_connected" as const),
      authMode: provider.authMode === "api_key" ? "API_KEY" : "OAUTH2",
      connectionId: conn?.id,
      connectedAt: conn?.createdAt,
    };
  });
}

// ─── Service Status Resolution ───────────────────────────────

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
 * Resolve service statuses for a flow's required services.
 * Used by flow detail and public share routes.
 */
export async function resolveServiceStatuses(
  services: FlowServiceRequirement[],
  adminConns: Record<string, string>,
  orgId: string,
  userId?: string,
): Promise<ServiceStatus[]> {
  return Promise.all(
    services.map(async (svc) => {
      const mode = svc.connectionMode ?? "user";
      const base = {
        id: svc.id,
        provider: svc.provider,
        description: svc.description ?? "",
      };

      const authMode = await getProviderAuthMode(svc.provider, orgId);
      const authModeLabel = authMode === "api_key" ? "API_KEY" : "OAUTH2";
      const scopesRequired = svc.scopes?.length ? svc.scopes : undefined;

      if (mode === "admin") {
        const adminUserId = adminConns[svc.id];
        if (adminUserId) {
          const [conn, adminProfile] = await Promise.all([
            getConnectionStatus(svc.provider, orgId, adminUserId),
            getUserProfile(adminUserId),
          ]);
          return {
            ...base,
            status: conn.status,
            authMode: authModeLabel,
            connectionMode: "admin" as const,
            adminProvided: true,
            adminUserId,
            adminDisplayName: adminProfile?.display_name ?? undefined,
            ...buildScopeInfo(conn.scopesGranted, scopesRequired, conn.status === "connected"),
          };
        }
        return {
          ...base,
          status: "not_connected" as const,
          authMode: authModeLabel,
          connectionMode: "admin" as const,
          adminProvided: false,
          ...(scopesRequired ? { scopesRequired } : {}),
        };
      }

      const conn = userId
        ? await getConnectionStatus(svc.provider, orgId, userId)
        : { status: "not_connected" as const };
      const connScopesGranted = "scopesGranted" in conn ? conn.scopesGranted : undefined;
      return {
        ...base,
        status: conn.status,
        authMode: authModeLabel,
        connectionMode: "user" as const,
        ...buildScopeInfo(connScopesGranted, scopesRequired, conn.status === "connected"),
      };
    }),
  );
}

// ─── Scope Validation ────────────────────────────────────────

export { validateScopes };
