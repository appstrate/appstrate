import { Nango } from "@nangohq/node";

const nango = new Nango({
  secretKey: process.env.NANGO_SECRET_KEY || "",
  host: process.env.NANGO_URL || "http://localhost:3003",
});

// MVP: single user
const END_USER_ID = "user-1";

export interface ConnectionStatus {
  provider: string;
  status: "connected" | "not_connected";
  connectionId?: string;
  connectedAt?: string;
}

// Cache provider → connectionId mapping (refreshed on listConnections)
const connectionIdCache = new Map<string, string>();

export async function listConnections(): Promise<ConnectionStatus[]> {
  try {
    const { connections } = await nango.listConnections();
    connectionIdCache.clear();
    return connections.map((c) => {
      connectionIdCache.set(c.provider_config_key, c.connection_id);
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

export async function getConnectionStatus(provider: string): Promise<ConnectionStatus> {
  // Refresh cache via listConnections
  const all = await listConnections();
  const found = all.find((c) => c.provider === provider);
  if (found) return found;
  return { provider, status: "not_connected" };
}

export async function getAccessToken(provider: string): Promise<string | null> {
  try {
    // Find the connection_id for this provider
    let connId = connectionIdCache.get(provider);
    if (!connId) {
      await listConnections();
      connId = connectionIdCache.get(provider);
    }
    if (!connId) return null;

    const connection = await nango.getConnection(provider, connId);
    const credentials = connection.credentials as { access_token?: string };
    return credentials.access_token ?? null;
  } catch {
    return null;
  }
}

export interface ConnectSession {
  token: string;
  connectLink: string;
  expiresAt: string;
}

export async function createConnectSession(provider: string): Promise<ConnectSession> {
  const result = await nango.createConnectSession({
    end_user: { id: END_USER_ID },
    allowed_integrations: [provider],
  });

  // Connect UI (port 3009) is not available in self-hosted mode.
  // Use the direct OAuth endpoint with the session token instead.
  const nangoUrl = process.env.NANGO_URL || "http://localhost:3003";
  const oauthUrl = `${nangoUrl}/oauth/connect/${provider}?connect_session_token=${result.data.token}`;

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

export async function deleteConnection(provider: string): Promise<void> {
  let connId = connectionIdCache.get(provider);
  if (!connId) {
    await listConnections();
    connId = connectionIdCache.get(provider);
  }
  if (!connId) throw new Error(`No connection found for ${provider}`);
  await nango.deleteConnection(provider, connId);
  connectionIdCache.delete(provider);
}

export interface IntegrationWithStatus {
  uniqueKey: string;
  provider: string;
  displayName: string;
  logo: string;
  status: "connected" | "not_connected";
  connectionId?: string;
  connectedAt?: string;
}

export async function getIntegrationsWithStatus(): Promise<IntegrationWithStatus[]> {
  const [integrations, connections] = await Promise.all([
    listIntegrations(),
    listConnections(),
  ]);
  return integrations.map((integ) => {
    const conn = connections.find((c) => c.provider === integ.unique_key);
    return {
      uniqueKey: integ.unique_key,
      provider: integ.provider,
      displayName: integ.display_name || integ.unique_key,
      logo: integ.logo,
      status: conn ? "connected" : "not_connected",
      connectionId: conn?.connectionId,
      connectedAt: conn?.connectedAt,
    };
  });
}

export { END_USER_ID };
