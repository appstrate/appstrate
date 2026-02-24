/**
 * Connection Manager — thin service wrapper over @appstrate/connect.
 * Single source for connection operations.
 * All functions operate on profileId (no more orgId/userId for credential access).
 */

import { db } from "../lib/db.ts";
import { logger } from "../lib/logger.ts";
import type { FlowServiceRequirement } from "../types/index.ts";
import type {
  ServiceStatus,
  UserConnectionItem,
  ProviderDisplayInfo,
} from "@appstrate/shared-types";

import { eq, inArray } from "drizzle-orm";
import {
  serviceConnections,
  connectionProfiles,
  organizationMembers,
  organizations,
} from "@appstrate/db/schema";

import { getEnv } from "@appstrate/env";
import {
  initiateOAuth,
  handleOAuthCallback,
  saveConnection,
  getConnection,
  listConnections as listConnectionsRaw,
  deleteConnection as deleteConnectionRaw,
  listProviders,
  getProviderAuthMode as getProviderAuthModeRaw,
  getProvider,
  getBuiltInProviders,
  validateScopes,
  type ConnectionRecord,
  type ProviderDefinition,
  type InitiateOAuthResult,
  type OAuthCallbackResult,
  type ScopeValidationResult,
} from "@appstrate/connect";
import { computeConfigHash, buildProviderSnapshot } from "./connection-profiles.ts";

// ─── Helpers ────────────────────────────────────────────────

/** Load provider definition and compute snapshot + configHash in one shot. */
async function getProviderSnapshot(
  orgId: string,
  providerId: string,
): Promise<{
  snapshot: ReturnType<typeof buildProviderSnapshot>;
  configHash: string;
}> {
  const providerDef = await getProvider(db, orgId, providerId);
  if (!providerDef) throw new Error(`Provider '${providerId}' not found`);
  return {
    snapshot: buildProviderSnapshot(providerDef),
    configHash: computeConfigHash(providerDef),
  };
}

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
  status: "connected" | "not_connected" | "needs_reconnection";
  connectionId?: string;
  connectedAt?: string;
  scopesGranted?: string[];
}

export async function getConnectionStatus(
  provider: string,
  profileId: string,
  orgId?: string,
): Promise<ConnectionStatus> {
  const conn = await getConnection(db, profileId, provider);
  if (conn) {
    // Check configHash if orgId is provided
    if (orgId) {
      const providerDef = await getProvider(db, orgId, provider);
      if (providerDef) {
        const currentHash = computeConfigHash(providerDef);
        if (currentHash !== conn.configHash) {
          return {
            provider,
            status: "needs_reconnection",
            connectionId: conn.id,
            connectedAt: conn.createdAt,
            scopesGranted: conn.scopesGranted,
          };
        }
      }
    }
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
  profileId: string,
  requestedScopes?: string[],
): Promise<{ authUrl: string; state: string }> {
  const apiEnv = getEnv();
  const redirectUri = apiEnv.OAUTH_CALLBACK_URL ?? `http://localhost:${apiEnv.PORT}/auth/callback`;
  return initiateOAuth(db, orgId, userId, profileId, provider, redirectUri, requestedScopes);
}

export async function handleCallback(code: string, state: string): Promise<OAuthCallbackResult> {
  const result = await handleOAuthCallback(db, code, state);

  const { snapshot, configHash } = await getProviderSnapshot(result.orgId, result.providerId);

  await saveConnection(
    db,
    result.profileId,
    result.providerId,
    "oauth2",
    {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
    },
    snapshot,
    configHash,
    {
      scopesGranted: result.scopesGranted,
      expiresAt: result.expiresAt,
      rawTokenResponse: result.rawResponse,
    },
  );

  logger.info("OAuth connection established", {
    providerId: result.providerId,
    profileId: result.profileId,
    scopes: result.scopesGranted,
  });

  return result;
}

// ─── API Key Connection ──────────────────────────────────────

export async function saveApiKeyConnection(
  provider: string,
  apiKey: string,
  profileId: string,
  orgId: string,
): Promise<void> {
  const { snapshot, configHash } = await getProviderSnapshot(orgId, provider);

  await saveConnection(
    db,
    profileId,
    provider,
    "api_key",
    { api_key: apiKey },
    snapshot,
    configHash,
  );

  logger.info("API key connection saved", { provider, profileId });
}

// ─── Generic Credentials Connection ──────────────────────────

export async function saveCredentialsConnection(
  provider: string,
  authMode: "basic" | "custom",
  credentials: Record<string, string>,
  profileId: string,
  orgId: string,
): Promise<void> {
  const { snapshot, configHash } = await getProviderSnapshot(orgId, provider);

  await saveConnection(db, profileId, provider, authMode, credentials, snapshot, configHash);

  logger.info("Credentials connection saved", { provider, authMode, profileId });
}

// ─── Connections List ────────────────────────────────────────

export async function listUserConnections(profileId: string): Promise<ConnectionStatus[]> {
  const connections = await listConnectionsRaw(db, profileId);
  return connections.map((c) => ({
    provider: c.providerId,
    status: "connected" as const,
    connectionId: c.id,
    connectedAt: c.createdAt,
    scopesGranted: c.scopesGranted,
  }));
}

// ─── Delete Connection ───────────────────────────────────────

export async function disconnectProvider(provider: string, profileId: string): Promise<void> {
  await deleteConnectionRaw(db, profileId, provider);
  logger.info("Connection deleted", { provider, profileId });
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
  status: "connected" | "not_connected" | "needs_reconnection";
  authMode?: string;
  connectionId?: string;
  connectedAt?: string;
}

export async function getIntegrationsWithStatus(
  profileId: string,
  orgId: string,
): Promise<IntegrationWithStatus[]> {
  const [providers, connections] = await Promise.all([
    listProviders(db, orgId),
    listConnectionsRaw(db, profileId),
  ]);

  return providers.map((provider) => {
    const conn = connections.find((c) => c.providerId === provider.id);
    let status: "connected" | "not_connected" | "needs_reconnection" = "not_connected";
    if (conn) {
      const currentHash = computeConfigHash(provider);
      status = currentHash !== conn.configHash ? "needs_reconnection" : "connected";
    }
    return {
      uniqueKey: provider.id,
      provider: provider.id,
      displayName: provider.displayName,
      logo: provider.iconUrl ?? "",
      status,
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
 * Uses profileId for both user and admin connections (via serviceProfiles map).
 */
export async function resolveServiceStatuses(
  services: FlowServiceRequirement[],
  adminConns: Record<string, string>,
  orgId: string,
  userProfileId?: string,
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
        const adminProfileId = adminConns[svc.id];
        if (adminProfileId) {
          const conn = await getConnectionStatus(svc.provider, adminProfileId, orgId);
          return {
            ...base,
            status: conn.status,
            authMode: authModeLabel,
            connectionMode: "admin" as const,
            adminProvided: true,
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

      const conn = userProfileId
        ? await getConnectionStatus(svc.provider, userProfileId, orgId)
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

// ─── All User Connections (cross-profile) ───────────────────

export async function listAllUserConnections(userId: string): Promise<{
  connections: UserConnectionItem[];
  providerInfo: Record<string, ProviderDisplayInfo>;
}> {
  // 1. Fetch connections with configHash
  const rows = await db
    .select({
      connectionId: serviceConnections.id,
      providerId: serviceConnections.providerId,
      authMode: serviceConnections.authMode,
      scopesGranted: serviceConnections.scopesGranted,
      connectedAt: serviceConnections.createdAt,
      configHash: serviceConnections.configHash,
      profileId: connectionProfiles.id,
      profileName: connectionProfiles.name,
      isDefault: connectionProfiles.isDefault,
    })
    .from(serviceConnections)
    .innerJoin(connectionProfiles, eq(serviceConnections.profileId, connectionProfiles.id))
    .where(eq(connectionProfiles.userId, userId));

  // 2. Fetch user's orgs
  const userOrgs = await db
    .select({
      orgId: organizationMembers.orgId,
      orgName: organizations.name,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(eq(organizationMembers.userId, userId));

  // 3. For each org, compute provider hashes (providerId → hash)
  const orgHashes = new Map<string, { name: string; hashes: Map<string, string> }>();
  for (const org of userOrgs) {
    const providers = await listProviders(db, org.orgId);
    const hashes = new Map<string, string>();
    for (const p of providers) {
      hashes.set(p.id, computeConfigHash(p));
    }
    orgHashes.set(org.orgId, { name: org.orgName, hashes });
  }

  // 4. Build connections with org matching
  const connections: UserConnectionItem[] = rows.map((r) => {
    const orgs: UserConnectionItem["orgs"] = [];
    for (const [orgId, { name, hashes }] of orgHashes) {
      const orgProviderHash = hashes.get(r.providerId);
      if (orgProviderHash !== undefined) {
        orgs.push({
          id: orgId,
          name,
          status: orgProviderHash === r.configHash ? "valid" : "needs_reconnection",
        });
      }
    }
    return {
      connectionId: r.connectionId,
      providerId: r.providerId,
      authMode: r.authMode,
      scopesGranted: r.scopesGranted ?? [],
      connectedAt: r.connectedAt?.toISOString() ?? "",
      profile: { id: r.profileId, name: r.profileName, isDefault: r.isDefault },
      orgs,
    };
  });

  // 5. Provider display info
  const uniqueProviderIds = [...new Set(rows.map((r) => r.providerId))];
  const builtIn = getBuiltInProviders();
  const providerInfo: Record<string, ProviderDisplayInfo> = {};
  for (const pid of uniqueProviderIds) {
    const p = builtIn.get(pid);
    providerInfo[pid] = {
      displayName: p?.displayName ?? pid,
      logo: p?.iconUrl ?? "",
    };
  }

  return { connections, providerInfo };
}

// ─── Delete All User Connections ─────────────────────────────

export async function deleteAllUserConnections(userId: string): Promise<void> {
  const profiles = await db
    .select({ id: connectionProfiles.id })
    .from(connectionProfiles)
    .where(eq(connectionProfiles.userId, userId));

  if (profiles.length === 0) return;

  await db.delete(serviceConnections).where(
    inArray(
      serviceConnections.profileId,
      profiles.map((p) => p.id),
    ),
  );

  logger.info("All user connections deleted", { userId });
}

// ─── Scope Validation ────────────────────────────────────────

export { validateScopes };
