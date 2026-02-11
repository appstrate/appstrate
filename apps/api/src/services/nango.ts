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
): Promise<void> {
  // Create a connect session token, then use it with Nango's API key auth endpoint
  const session = await nango.createConnectSession({
    end_user: { id: END_USER_ID },
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
  // Find the connection_id for this provider
  let connId = connectionIdCache.get(provider);
  if (!connId) {
    await listConnections();
    connId = connectionIdCache.get(provider);
  }
  if (!connId) return null; // No connection exists — expected

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
    console.error(`[nango] Failed to fetch access token for '${provider}':`, err);
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
  const nangoHost = process.env.NANGO_URL || "http://localhost:3003";
  const oauthUrl = `${nangoHost}/oauth/connect/${provider}?connect_session_token=${result.data.token}`;

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
  authMode?: string;
  connectionId?: string;
  connectedAt?: string;
}

export async function getIntegrationsWithStatus(): Promise<IntegrationWithStatus[]> {
  const [integrations, connections] = await Promise.all([listIntegrations(), listConnections()]);
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

export { END_USER_ID };
