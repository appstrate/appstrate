import { eq, and } from "drizzle-orm";
import { serviceConnections, providerCredentials, packages } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ConnectionRecord, DecryptedCredentials } from "./types.ts";
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
 * Handles token refresh for OAuth2 connections by looking up provider
 * definition and credentials from the DB.
 * Pass orgId to enable token refresh for OAuth2 connections.
 */
export async function getCredentials(
  db: Db,
  profileId: string,
  providerId: string,
  orgId?: string,
): Promise<{ credentials: Record<string, string>; connection: ConnectionRecord } | null> {
  const connection = await getConnection(db, profileId, providerId);
  if (!connection) return null;

  let decrypted: DecryptedCredentials;

  // Look up the provider definition from packages.manifest.definition
  const [pkg] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, providerId))
    .limit(1);

  const manifest = (pkg?.draftManifest ?? {}) as Record<string, unknown>;
  const def = (manifest.definition ?? {}) as Record<string, unknown>;
  const authMode = def.authMode as string | undefined;

  if (authMode === "oauth2") {
    // Build refresh context from manifest.definition + providerCredentials
    let refreshContext;
    const tokenUrl = (def.refreshUrl as string) ?? (def.tokenUrl as string);
    if (tokenUrl && orgId) {
      const [cred] = await db
        .select({
          credentialsEncrypted: providerCredentials.credentialsEncrypted,
        })
        .from(providerCredentials)
        .where(
          and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.orgId, orgId)),
        )
        .limit(1);

      if (cred?.credentialsEncrypted) {
        const adminCreds = decryptCredentials<Record<string, string>>(cred.credentialsEncrypted);
        if (adminCreds.clientId && adminCreds.clientSecret) {
          refreshContext = {
            tokenUrl,
            clientId: adminCreds.clientId,
            clientSecret: adminCreds.clientSecret,
            tokenAuthMethod: (def.tokenAuthMethod as string) ?? undefined,
            scopeSeparator: (def.scopeSeparator as string) ?? undefined,
          };
        }
      }
    }

    decrypted = await refreshIfNeeded(
      db,
      connection.id,
      connection.providerId,
      connection.credentialsEncrypted,
      connection.expiresAt,
      refreshContext,
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
 * Reads authorizedUris and field names from packages.manifest.definition.
 */
export async function resolveCredentialsForProxy(
  db: Db,
  profileId: string,
  providerId: string,
  orgId?: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const result = await getCredentials(db, profileId, providerId, orgId);
  if (!result) return null;

  // Look up provider definition from packages.draftManifest.definition
  const [pkg] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, providerId))
    .limit(1);

  const manifest = (pkg?.draftManifest ?? {}) as Record<string, unknown>;
  const def = (manifest.definition ?? {}) as Record<string, unknown>;
  const authMode = def.authMode as string | undefined;

  let sidecarCredentials: Record<string, string>;
  if (authMode === "oauth2" || authMode === "api_key") {
    const fieldName =
      (def.credentialFieldName as string) ?? (authMode === "api_key" ? "api_key" : "token");
    const value = result.credentials.access_token ?? result.credentials.api_key;
    if (value) {
      sidecarCredentials = { [fieldName]: value };
    } else {
      sidecarCredentials = result.credentials;
    }
  } else {
    sidecarCredentials = result.credentials;
  }

  const authorizedUris = (def.authorizedUris as string[])?.length
    ? (def.authorizedUris as string[])
    : null;
  const allowAllUris = (def.allowAllUris as boolean) ?? false;

  return {
    credentials: sidecarCredentials,
    authorizedUris,
    allowAllUris,
  };
}

/**
 * Save a connection (upsert on profileId + providerId).
 */
export async function saveConnection(
  db: Db,
  profileId: string,
  providerId: string,
  credentials: Record<string, unknown>,
  options?: {
    scopesGranted?: string[];
    expiresAt?: string | null;
  },
): Promise<void> {
  const encrypted = encryptCredentials(credentials);

  await db
    .insert(serviceConnections)
    .values({
      profileId,
      providerId,
      credentialsEncrypted: encrypted,
      scopesGranted: options?.scopesGranted ?? [],
      expiresAt: options?.expiresAt ? new Date(options.expiresAt) : null,
      rawTokenResponse: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [serviceConnections.profileId, serviceConnections.providerId],
      set: {
        credentialsEncrypted: encrypted,
        scopesGranted: options?.scopesGranted ?? [],
        expiresAt: options?.expiresAt ? new Date(options.expiresAt) : null,
        rawTokenResponse: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Delete all connections for a provider on a profile.
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

/**
 * Delete a single connection by its ID.
 */
export async function deleteConnectionById(db: Db, connectionId: string): Promise<void> {
  await db.delete(serviceConnections).where(eq(serviceConnections.id, connectionId));
}

// --- Internal helpers ---

function rowToConnection(row: typeof serviceConnections.$inferSelect): ConnectionRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    providerId: row.providerId,
    credentialsEncrypted: row.credentialsEncrypted,
    scopesGranted: (row.scopesGranted as string[]) ?? [],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
  };
}
