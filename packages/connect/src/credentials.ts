import type { Json } from "@appstrate/shared-types";
import type { ConnectionRecord, DecryptedCredentials, AuthMode } from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { refreshIfNeeded } from "./token-refresh.ts";
import { getProvider, getCredentialFieldName, getDefaultAuthorizedUris } from "./registry.ts";
import type { SupabaseClient } from "./registry.ts";
import { extractErrorMessage } from "./utils.ts";

/**
 * Get a connection by provider/user/org (global or flow-specific).
 */
export async function getConnection(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<ConnectionRecord | null> {
  const query = supabase.from("service_connections")
    .select("*")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("provider_id", providerId);

  const result = flowId
    ? await query.eq("flow_id", flowId).single()
    : await query.is("flow_id", null).single();

  if (!result.data) return null;
  return rowToConnection(result.data);
}

/**
 * Check if a connection exists.
 */
export async function hasConnection(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<boolean> {
  const conn = await getConnection(supabase, orgId, userId, providerId, flowId);
  return conn !== null;
}

/**
 * List all connections for a user within an org.
 */
export async function listConnections(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
): Promise<ConnectionRecord[]> {
  const { data: rows } = await supabase.from("service_connections")
    .select("*")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .is("flow_id", null); // Global connections only

  return (rows ?? []).map(rowToConnection);
}

/**
 * Get decrypted credentials for a service.
 * Handles token refresh for OAuth2 connections.
 */
export async function getCredentials(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<{ credentials: Record<string, string>; connection: ConnectionRecord } | null> {
  const connection = await getConnection(supabase, orgId, userId, providerId, flowId);
  if (!connection) return null;

  let decrypted: DecryptedCredentials;

  if (connection.authMode === "oauth2") {
    // Refresh if needed
    decrypted = await refreshIfNeeded(
      supabase,
      orgId,
      connection.id,
      connection.providerId,
      connection.credentialsEncrypted,
      connection.expiresAt,
    );
  } else {
    decrypted = decryptCredentials<DecryptedCredentials>(connection.credentialsEncrypted);
  }

  // Build credentials in the format expected by the sidecar
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(decrypted)) {
    if (value !== undefined) {
      credentials[key] = value;
    }
  }

  return { credentials, connection };
}

/**
 * Resolve credentials for the sidecar proxy.
 * Returns the credentials in the format { [fieldName]: value } + authorizedUris from the provider.
 */
export async function resolveCredentialsForProxy(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  providerId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const result = await getCredentials(supabase, orgId, userId, providerId);
  if (!result) return null;

  // Resolve the provider to get credential field info and URI restrictions
  const provider = await getProvider(supabase, orgId, providerId);

  let sidecarCredentials: Record<string, string>;
  if (provider && (provider.authMode === "oauth2" || provider.authMode === "api_key")) {
    const fieldName = getCredentialFieldName(provider);
    const value = result.credentials.access_token ?? result.credentials.api_key;
    if (value) {
      sidecarCredentials = { [fieldName]: value };
    } else {
      // No standard credential field found — pass through all credentials
      console.warn(`No access_token or api_key found for provider '${providerId}', passing all credentials`);
      sidecarCredentials = result.credentials;
    }
  } else {
    // Custom/basic services: pass through all credentials as-is
    sidecarCredentials = result.credentials;
  }

  // Resolve authorized URIs and allowAllUris from the provider
  const authorizedUris = provider ? getDefaultAuthorizedUris(provider) : null;
  const allowAllUris = provider?.allowAllUris ?? false;

  return {
    credentials: sidecarCredentials,
    authorizedUris,
    allowAllUris,
  };
}

/**
 * Save a connection (atomic upsert via RPC).
 */
export async function saveConnection(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  providerId: string,
  authMode: AuthMode,
  credentials: Record<string, unknown>,
  options?: {
    flowId?: string | null;
    scopesGranted?: string[];
    expiresAt?: string | null;
    rawTokenResponse?: Record<string, unknown>;
    connectionConfig?: Record<string, unknown>;
  },
): Promise<void> {
  const encrypted = encryptCredentials(credentials);

  const { error } = await supabase.rpc("upsert_service_connection", {
    p_org_id: orgId,
    p_user_id: userId,
    p_provider_id: providerId,
    p_flow_id: options?.flowId ?? undefined,
    p_auth_mode: authMode,
    p_credentials_encrypted: encrypted,
    p_scopes_granted: options?.scopesGranted ?? [],
    p_expires_at: options?.expiresAt ?? undefined,
    p_raw_token_response: (options?.rawTokenResponse ?? undefined) as Json | undefined,
    p_connection_config: (options?.connectionConfig ?? {}) as Json,
  });

  if (error) {
    throw new Error(`Failed to save connection: ${extractErrorMessage(error)}`);
  }
}

/**
 * Delete a connection (via RPC, handles NULL flow_id).
 */
export async function deleteConnection(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<void> {
  await supabase.rpc("delete_service_connection", {
    p_org_id: orgId,
    p_user_id: userId,
    p_provider_id: providerId,
    p_flow_id: flowId ?? undefined,
  });
}

// --- Internal helpers ---

function rowToConnection(row: Record<string, unknown>): ConnectionRecord {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    userId: row.user_id as string,
    providerId: row.provider_id as string,
    flowId: (row.flow_id as string) ?? null,
    authMode: row.auth_mode as AuthMode,
    credentialsEncrypted: row.credentials_encrypted as string,
    scopesGranted: (row.scopes_granted as string[]) ?? [],
    expiresAt: (row.expires_at as string) ?? null,
    rawTokenResponse: (row.raw_token_response as Record<string, unknown>) ?? null,
    connectionConfig: (row.connection_config as Record<string, unknown>) ?? {},
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
