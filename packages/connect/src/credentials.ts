import { eq, and } from "drizzle-orm";
import { serviceConnections } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type {
  ConnectionRecord,
  DecryptedCredentials,
  AuthMode,
  ProviderSnapshot,
} from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { refreshIfNeeded } from "./token-refresh.ts";

/**
 * Get a connection by profile + provider.
 */
export async function getConnection(
  db: Db,
  profileId: string,
  providerId: string,
): Promise<ConnectionRecord | null> {
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(
      and(
        eq(serviceConnections.profileId, profileId),
        eq(serviceConnections.providerId, providerId),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  return rowToConnection(rows[0]!);
}

/**
 * List all connections for a profile.
 */
export async function listConnections(db: Db, profileId: string): Promise<ConnectionRecord[]> {
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(eq(serviceConnections.profileId, profileId));

  return rows.map(rowToConnection);
}

/**
 * Get decrypted credentials for a service.
 * Handles token refresh for OAuth2 connections using providerSnapshot.
 */
export async function getCredentials(
  db: Db,
  profileId: string,
  providerId: string,
): Promise<{ credentials: Record<string, string>; connection: ConnectionRecord } | null> {
  const connection = await getConnection(db, profileId, providerId);
  if (!connection) return null;

  let decrypted: DecryptedCredentials;

  if (connection.authMode === "oauth2") {
    decrypted = await refreshIfNeeded(
      db,
      connection.id,
      connection.providerId,
      connection.credentialsEncrypted,
      connection.expiresAt,
      connection.providerSnapshot,
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
 * Reads authorizedUris and field names from providerSnapshot on the connection.
 */
export async function resolveCredentialsForProxy(
  db: Db,
  profileId: string,
  providerId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const result = await getCredentials(db, profileId, providerId);
  if (!result) return null;

  const snapshot = result.connection.providerSnapshot;

  let sidecarCredentials: Record<string, string>;
  if (snapshot.authMode === "oauth2" || snapshot.authMode === "api_key") {
    const fieldName =
      snapshot.credentialFieldName ?? (snapshot.authMode === "api_key" ? "api_key" : "token");
    const value = result.credentials.access_token ?? result.credentials.api_key;
    if (value) {
      sidecarCredentials = { [fieldName]: value };
    } else {
      sidecarCredentials = result.credentials;
    }
  } else {
    sidecarCredentials = result.credentials;
  }

  const authorizedUris = snapshot.authorizedUris?.length ? snapshot.authorizedUris : null;
  const allowAllUris = snapshot.allowAllUris ?? false;

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
  profileId: string,
  providerId: string,
  authMode: AuthMode,
  credentials: Record<string, unknown>,
  providerSnapshot: ProviderSnapshot,
  configHash: string,
  options?: {
    scopesGranted?: string[];
    expiresAt?: string | null;
    rawTokenResponse?: Record<string, unknown>;
  },
): Promise<void> {
  const encrypted = encryptCredentials(credentials);

  await db.transaction(async (tx) => {
    // Delete existing connection
    await tx
      .delete(serviceConnections)
      .where(
        and(
          eq(serviceConnections.profileId, profileId),
          eq(serviceConnections.providerId, providerId),
        ),
      );

    // Insert new connection
    await tx.insert(serviceConnections).values({
      profileId,
      providerId,
      authMode,
      credentialsEncrypted: encrypted,
      scopesGranted: options?.scopesGranted ?? [],
      expiresAt: options?.expiresAt ? new Date(options.expiresAt) : null,
      rawTokenResponse: options?.rawTokenResponse ?? null,
      providerSnapshot,
      configHash,
      updatedAt: new Date(),
    });
  });
}

/**
 * Delete a connection.
 */
export async function deleteConnection(
  db: Db,
  profileId: string,
  providerId: string,
): Promise<void> {
  await db
    .delete(serviceConnections)
    .where(
      and(
        eq(serviceConnections.profileId, profileId),
        eq(serviceConnections.providerId, providerId),
      ),
    );
}

// --- Internal helpers ---

function rowToConnection(row: typeof serviceConnections.$inferSelect): ConnectionRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    providerId: row.providerId,
    authMode: row.authMode as AuthMode,
    credentialsEncrypted: row.credentialsEncrypted,
    scopesGranted: (row.scopesGranted as string[]) ?? [],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    rawTokenResponse: (row.rawTokenResponse as Record<string, unknown>) ?? null,
    providerSnapshot: row.providerSnapshot as ProviderSnapshot,
    configHash: row.configHash,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
  };
}
