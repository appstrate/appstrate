import { Nango } from "@nangohq/node";
import { logger } from "../lib/logger.ts";

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

// Per-user connection cache: "userId:provider" → connectionId
const connectionIdCache = new Map<string, string>();

function cacheKey(userId: string, provider: string): string {
  return `${userId}:${provider}`;
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
  userId: string,
): Promise<void> {
  const session = await nango.createConnectSession({
    end_user: { id: userId },
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

export async function listConnections(userId: string): Promise<ConnectionStatus[]> {
  try {
    const { connections } = await nango.listConnections();
    // Filter connections by end_user.id for the current user
    const userConnections = connections.filter(
      (c) => (c as unknown as { end_user?: { id?: string } }).end_user?.id === userId,
    );
    // Rebuild cache for this user
    for (const key of connectionIdCache.keys()) {
      if (key.startsWith(`${userId}:`)) connectionIdCache.delete(key);
    }
    return userConnections.map((c) => {
      connectionIdCache.set(cacheKey(userId, c.provider_config_key), c.connection_id);
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
  userId: string,
): Promise<ConnectionStatus> {
  const all = await listConnections(userId);
  const found = all.find((c) => c.provider === provider);
  if (found) return found;
  return { provider, status: "not_connected" };
}

export async function getAccessToken(provider: string, userId: string): Promise<string | null> {
  let connId = connectionIdCache.get(cacheKey(userId, provider));
  if (!connId) {
    await listConnections(userId);
    connId = connectionIdCache.get(cacheKey(userId, provider));
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
  userId: string,
): Promise<ConnectSession> {
  const result = await nango.createConnectSession({
    end_user: { id: userId },
    allowed_integrations: [provider],
  });

  const nangoPublicHost = process.env.NANGO_PUBLIC_URL || process.env.NANGO_URL || "http://localhost:3003";
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

export async function deleteConnection(provider: string, userId: string): Promise<void> {
  let connId = connectionIdCache.get(cacheKey(userId, provider));
  if (!connId) {
    await listConnections(userId);
    connId = connectionIdCache.get(cacheKey(userId, provider));
  }
  if (!connId) throw new Error(`No connection found for ${provider}`);
  await nango.deleteConnection(provider, connId);
  connectionIdCache.delete(cacheKey(userId, provider));
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

export async function getIntegrationsWithStatus(userId: string): Promise<IntegrationWithStatus[]> {
  const [integrations, connections] = await Promise.all([
    listIntegrations(),
    listConnections(userId),
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
