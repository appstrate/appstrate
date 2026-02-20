import { Nango } from "@nangohq/node";
import { logger } from "../lib/logger.ts";
import { getUserProfile } from "../lib/supabase.ts";
import { hasCustomCredentials } from "./state.ts";
import type { FlowServiceRequirement } from "../types/index.ts";
import type { ServiceStatus } from "@appstrate/shared-types";

const nango = new Nango({
  secretKey: process.env.NANGO_SECRET_KEY || "",
  host: process.env.NANGO_URL || "http://localhost:3003",
});

export interface ConnectionStatus {
  provider: string;
  status: "connected" | "not_connected";
  connectionId?: string;
  connectedAt?: string;
}

/** Composite end_user.id for Nango: org-scoped per user */
function nangoEndUserId(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

// Per-user connection cache: "orgId:userId:provider" → connectionId
const connectionIdCache = new Map<string, string>();

function cacheKey(orgId: string, userId: string, provider: string): string {
  return `${orgId}:${userId}:${provider}`;
}

// Cache provider → auth_mode (static, fetched once per provider)
const authModeCache = new Map<string, string>();

export async function getProviderAuthMode(providerName: string): Promise<string | undefined> {
  if (authModeCache.has(providerName)) return authModeCache.get(providerName);

  try {
    const result = await nango.getProvider({ provider: providerName });
    const authMode = (result as { data: { auth_mode?: string } }).data.auth_mode;
    if (authMode) authModeCache.set(providerName, authMode);
    return authMode;
  } catch {
    return undefined;
  }
}

export async function createApiKeyConnection(
  provider: string,
  apiKey: string,
  orgId: string,
  userId: string,
): Promise<void> {
  const session = await nango.createConnectSession({
    end_user: { id: nangoEndUserId(orgId, userId) },
    allowed_integrations: [provider],
  });
  const nangoHost = process.env.NANGO_URL || "http://localhost:3003";
  const res = await fetch(
    `${nangoHost}/api-auth/api-key/${provider}?connect_session_token=${session.data.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create API key connection: ${res.status} ${body}`);
  }
}

export async function listConnections(orgId: string, userId: string): Promise<ConnectionStatus[]> {
  const endUserId = nangoEndUserId(orgId, userId);
  try {
    const { connections } = await nango.listConnections({ userId: endUserId });
    // Rebuild cache for this org:user
    const prefix = `${orgId}:${userId}:`;
    for (const key of connectionIdCache.keys()) {
      if (key.startsWith(prefix)) connectionIdCache.delete(key);
    }
    return connections.map((c) => {
      connectionIdCache.set(cacheKey(orgId, userId, c.provider_config_key), c.connection_id);
      return {
        provider: c.provider_config_key,
        status: "connected" as const,
        connectionId: c.connection_id,
        connectedAt: c.created as string,
      };
    });
  } catch {
    return [];
  }
}

export async function getConnectionStatus(
  provider: string,
  orgId: string,
  userId: string,
): Promise<ConnectionStatus> {
  const all = await listConnections(orgId, userId);
  const found = all.find((c) => c.provider === provider);
  if (found) return found;
  return { provider, status: "not_connected" };
}

export async function getAccessToken(
  provider: string,
  orgId: string,
  userId: string,
): Promise<string | null> {
  let connId = connectionIdCache.get(cacheKey(orgId, userId, provider));
  if (!connId) {
    await listConnections(orgId, userId);
    connId = connectionIdCache.get(cacheKey(orgId, userId, provider));
  }
  if (!connId) return null;

  try {
    const connection = await nango.getConnection(provider, connId);
    const credentials = connection.credentials as {
      type?: string;
      access_token?: string;
      apiKey?: string;
    };
    if (credentials.type === "API_KEY" || credentials.apiKey) {
      return credentials.apiKey ?? null;
    }
    return credentials.access_token ?? null;
  } catch (err) {
    logger.error("Failed to fetch access token", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ConnectSession {
  token: string;
  connectLink: string;
  expiresAt: string;
}

export async function createConnectSession(
  provider: string,
  orgId: string,
  userId: string,
): Promise<ConnectSession> {
  const result = await nango.createConnectSession({
    end_user: { id: nangoEndUserId(orgId, userId) },
    allowed_integrations: [provider],
  });

  const nangoPublicHost =
    process.env.NANGO_PUBLIC_URL || process.env.NANGO_URL || "http://localhost:3003";
  const oauthUrl = `${nangoPublicHost}/oauth/connect/${provider}?connect_session_token=${result.data.token}`;

  return {
    token: result.data.token,
    connectLink: oauthUrl,
    expiresAt: result.data.expires_at,
  };
}

export async function listIntegrations() {
  const { configs } = await nango.listIntegrations();
  return configs;
}

export async function deleteConnection(
  provider: string,
  orgId: string,
  userId: string,
): Promise<void> {
  let connId = connectionIdCache.get(cacheKey(orgId, userId, provider));
  if (!connId) {
    await listConnections(orgId, userId);
    connId = connectionIdCache.get(cacheKey(orgId, userId, provider));
  }
  if (!connId) throw new Error(`No connection found for ${provider}`);
  await nango.deleteConnection(provider, connId);
  connectionIdCache.delete(cacheKey(orgId, userId, provider));
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

export async function getIntegrationsWithStatus(
  orgId: string,
  userId: string,
): Promise<IntegrationWithStatus[]> {
  const [integrations, connections] = await Promise.all([
    listIntegrations(),
    listConnections(orgId, userId),
  ]);
  const results = await Promise.all(
    integrations.map(async (integ) => {
      const conn = connections.find((c) => c.provider === integ.unique_key);
      const authMode = await getProviderAuthMode(integ.unique_key);
      return {
        uniqueKey: integ.unique_key,
        provider: integ.provider,
        displayName: integ.display_name || integ.unique_key,
        logo: integ.logo,
        status: conn ? ("connected" as const) : ("not_connected" as const),
        authMode,
        connectionId: conn?.connectionId,
        connectedAt: conn?.connectedAt,
      };
    }),
  );
  return results;
}

/**
 * Resolve service statuses for a flow's required services.
 * Used by both flow detail and public share routes.
 */
export async function resolveServiceStatuses(
  services: FlowServiceRequirement[],
  adminConns: Record<string, string>,
  orgId: string,
  userId?: string,
  flowId?: string,
): Promise<ServiceStatus[]> {
  return Promise.all(
    services.map(async (svc) => {
      const mode = svc.connectionMode ?? "user";

      // Custom service — check custom_service_credentials instead of Nango
      if (svc.provider === "custom") {
        if (mode === "admin") {
          const adminUserId = adminConns[svc.id];
          if (adminUserId && flowId) {
            const [hasCreds, adminProfile] = await Promise.all([
              hasCustomCredentials(orgId, adminUserId, flowId, svc.id),
              getUserProfile(adminUserId),
            ]);
            return {
              id: svc.id,
              provider: svc.provider,
              description: svc.description,
              status: hasCreds ? ("connected" as const) : ("not_connected" as const),
              connectionMode: "admin" as const,
              adminProvided: true,
              adminUserId,
              adminDisplayName: adminProfile?.display_name ?? undefined,
              schema: svc.schema,
              authorizedUris: svc.authorized_uris,
              allowAllUris: svc.allow_all_uris,
            };
          }
          return {
            id: svc.id,
            provider: svc.provider,
            description: svc.description,
            status: "not_connected" as const,
            connectionMode: "admin" as const,
            adminProvided: false,
            schema: svc.schema,
            authorizedUris: svc.authorized_uris,
            allowAllUris: svc.allow_all_uris,
          };
        }

        const connected =
          userId && flowId ? await hasCustomCredentials(orgId, userId, flowId, svc.id) : false;
        return {
          id: svc.id,
          provider: svc.provider,
          description: svc.description,
          status: connected ? ("connected" as const) : ("not_connected" as const),
          connectionMode: "user" as const,
          schema: svc.schema,
          authorizedUris: svc.authorized_uris,
          allowAllUris: svc.allow_all_uris,
        };
      }

      // Nango service
      const authMode = await getProviderAuthMode(svc.provider);

      if (mode === "admin") {
        const adminUserId = adminConns[svc.id];
        if (adminUserId) {
          const [conn, adminProfile] = await Promise.all([
            getConnectionStatus(svc.provider, orgId, adminUserId),
            getUserProfile(adminUserId),
          ]);
          return {
            id: svc.id,
            provider: svc.provider,
            description: svc.description,
            status: conn.status,
            authMode,
            connectionMode: "admin" as const,
            adminProvided: true,
            adminUserId,
            adminDisplayName: adminProfile?.display_name ?? undefined,
            authorizedUris: svc.authorized_uris,
            allowAllUris: svc.allow_all_uris,
          };
        }
        return {
          id: svc.id,
          provider: svc.provider,
          description: svc.description,
          status: "not_connected" as const,
          authMode,
          connectionMode: "admin" as const,
          adminProvided: false,
          authorizedUris: svc.authorized_uris,
          allowAllUris: svc.allow_all_uris,
        };
      }

      const conn = userId
        ? await getConnectionStatus(svc.provider, orgId, userId)
        : { status: "not_connected" as const };
      return {
        id: svc.id,
        provider: svc.provider,
        description: svc.description,
        status: conn.status,
        authMode,
        connectionMode: "user" as const,
        authorizedUris: svc.authorized_uris,
        allowAllUris: svc.allow_all_uris,
      };
    }),
  );
}
