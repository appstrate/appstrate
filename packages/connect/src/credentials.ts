import { eq, and, isNull } from "drizzle-orm";
import { serviceConnections } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ConnectionRecord, DecryptedCredentials, AuthMode } from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { refreshIfNeeded } from "./token-refresh.ts";
import { getProvider, getCredentialFieldName, getDefaultAuthorizedUris } from "./registry.ts";

/**
 * Get a connection by provider/user/org (global or flow-specific).
 */
export async function getConnection(
  db: Db,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<ConnectionRecord | null> {
  const conditions = [
    eq(serviceConnections.orgId, orgId),
    eq(serviceConnections.userId, userId),
    eq(serviceConnections.providerId, providerId),
  ];

  if (flowId) {
    conditions.push(eq(serviceConnections.flowId, flowId));
  } else {
    conditions.push(isNull(serviceConnections.flowId));
  }

  const rows = await db
    .select()
    .from(serviceConnections)
    .where(and(...conditions))
    .limit(1);

  if (rows.length === 0) return null;
  return rowToConnection(rows[0]!);
}

/**
 * Check if a connection exists.
 */
export async function hasConnection(
  db: Db,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<boolean> {
  const conn = await getConnection(db, orgId, userId, providerId, flowId);
  return conn !== null;
}

/**
 * List all connections for a user within an org.
 */
export async function listConnections(
  db: Db,
  orgId: string,
  userId: string,
): Promise<ConnectionRecord[]> {
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(
      and(
        eq(serviceConnections.orgId, orgId),
        eq(serviceConnections.userId, userId),
        isNull(serviceConnections.flowId),
      ),
    );

  return rows.map(rowToConnection);
}

/**
 * Get decrypted credentials for a service.
 * Handles token refresh for OAuth2 connections.
 */
export async function getCredentials(
  db: Db,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<{ credentials: Record<string, string>; connection: ConnectionRecord } | null> {
  const connection = await getConnection(db, orgId, userId, providerId, flowId);
  if (!connection) return null;

  let decrypted: DecryptedCredentials;

  if (connection.authMode === "oauth2") {
    decrypted = await refreshIfNeeded(
      db,
      orgId,
      connection.id,
      connection.providerId,
      connection.credentialsEncrypted,
      connection.expiresAt,
    );
  } else {
    decrypted = decryptCredentials<DecryptedCredentials>(connection.credentialsEncrypted);
  }

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
  db: Db,
  orgId: string,
  userId: string,
  providerId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const result = await getCredentials(db, orgId, userId, providerId);
  if (!result) return null;

  const provider = await getProvider(db, orgId, providerId);

  let sidecarCredentials: Record<string, string>;
  if (provider && (provider.authMode === "oauth2" || provider.authMode === "api_key")) {
    const fieldName = getCredentialFieldName(provider);
    const value = result.credentials.access_token ?? result.credentials.api_key;
    if (value) {
      sidecarCredentials = { [fieldName]: value };
    } else {
      console.warn(
        `No access_token or api_key found for provider '${providerId}', passing all credentials`,
      );
      sidecarCredentials = result.credentials;
    }
  } else {
    sidecarCredentials = result.credentials;
  }

  const authorizedUris = provider ? getDefaultAuthorizedUris(provider) : null;
  const allowAllUris = provider?.allowAllUris ?? false;

  return {
    credentials: sidecarCredentials,
    authorizedUris,
    allowAllUris,
  };
}

/**
 * Save a connection (atomic upsert via transaction: delete + insert).
 */
export async function saveConnection(
  db: Db,
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
  const flowId = options?.flowId ?? null;

  await db.transaction(async (tx) => {
    // Delete existing connection
    const deleteConditions = [
      eq(serviceConnections.orgId, orgId),
      eq(serviceConnections.userId, userId),
      eq(serviceConnections.providerId, providerId),
    ];
    if (flowId) {
      deleteConditions.push(eq(serviceConnections.flowId, flowId));
    } else {
      deleteConditions.push(isNull(serviceConnections.flowId));
    }
    await tx.delete(serviceConnections).where(and(...deleteConditions));

    // Insert new connection
    await tx.insert(serviceConnections).values({
      orgId,
      userId,
      providerId,
      flowId,
      authMode,
      credentialsEncrypted: encrypted,
      scopesGranted: options?.scopesGranted ?? [],
      expiresAt: options?.expiresAt ? new Date(options.expiresAt) : null,
      rawTokenResponse: options?.rawTokenResponse ?? null,
      connectionConfig: options?.connectionConfig ?? {},
      updatedAt: new Date(),
    });
  });
}

/**
 * Delete a connection (handles NULL flow_id).
 */
export async function deleteConnection(
  db: Db,
  orgId: string,
  userId: string,
  providerId: string,
  flowId?: string | null,
): Promise<void> {
  const conditions = [
    eq(serviceConnections.orgId, orgId),
    eq(serviceConnections.userId, userId),
    eq(serviceConnections.providerId, providerId),
  ];
  if (flowId) {
    conditions.push(eq(serviceConnections.flowId, flowId));
  } else {
    conditions.push(isNull(serviceConnections.flowId));
  }

  await db.delete(serviceConnections).where(and(...conditions));
}

// --- Internal helpers ---

function rowToConnection(row: typeof serviceConnections.$inferSelect): ConnectionRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    providerId: row.providerId,
    flowId: row.flowId ?? null,
    authMode: row.authMode as AuthMode,
    credentialsEncrypted: row.credentialsEncrypted,
    scopesGranted: (row.scopesGranted as string[]) ?? [],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    rawTokenResponse: (row.rawTokenResponse as Record<string, unknown>) ?? null,
    connectionConfig: (row.connectionConfig as Record<string, unknown>) ?? {},
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
  };
}
