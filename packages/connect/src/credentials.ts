import { eq, and } from "drizzle-orm";
import { serviceConnections, providerCredentials, packages } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ConnectionRecord, DecryptedCredentials } from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { refreshIfNeeded } from "./token-refresh.ts";

/**
 * Get a connection by profile + provider + org.
 */
export async function getConnection(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
): Promise<ConnectionRecord | null> {
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(
      and(
        eq(serviceConnections.profileId, profileId),
        eq(serviceConnections.providerId, providerId),
        eq(serviceConnections.orgId, orgId),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  return rowToConnection(rows[0]!);
}

/**
 * List all connections for a profile within an org.
 */
export async function listConnections(
  db: Db,
  profileId: string,
  orgId: string,
): Promise<ConnectionRecord[]> {
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(and(eq(serviceConnections.profileId, profileId), eq(serviceConnections.orgId, orgId)));

  return rows.map(rowToConnection);
}

/** Fetch provider definition from packages.draftManifest.definition. */
async function getProviderDefinition(db: Db, providerId: string): Promise<Record<string, unknown>> {
  const [pkg] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, providerId))
    .limit(1);

  const manifest = (pkg?.draftManifest ?? {}) as Record<string, unknown>;
  return (manifest.definition ?? {}) as Record<string, unknown>;
}

/**
 * Get decrypted credentials for a service.
 * Handles token refresh for OAuth2 connections by looking up provider
 * definition and credentials from the DB.
 */
export async function getCredentials(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
): Promise<{
  credentials: Record<string, string>;
  connection: ConnectionRecord;
  definition: Record<string, unknown>;
} | null> {
  const connection = await getConnection(db, profileId, providerId, orgId);
  if (!connection) return null;

  const def = await getProviderDefinition(db, providerId);
  const authMode = def.authMode as string | undefined;

  let decrypted: DecryptedCredentials;

  if (authMode === "oauth2") {
    let refreshContext;
    const oauth2 = (def.oauth2 as Record<string, unknown>) ?? {};
    const tokenUrl = (oauth2.refreshUrl as string) ?? (oauth2.tokenUrl as string);
    if (tokenUrl) {
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
            tokenAuthMethod: (oauth2.tokenAuthMethod as string) ?? undefined,
            scopeSeparator: (oauth2.scopeSeparator as string) ?? undefined,
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

  return { credentials, connection, definition: def };
}

/**
 * Resolve credentials for the sidecar proxy.
 * Reads authorizedUris and field names from packages.manifest.definition.
 */
export async function resolveCredentialsForProxy(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const result = await getCredentials(db, profileId, providerId, orgId);
  if (!result) return null;

  const def = result.definition;
  const authMode = def.authMode as string | undefined;

  let sidecarCredentials: Record<string, string>;
  if (authMode === "oauth2" || authMode === "api_key") {
    const creds = (def.credentials as Record<string, unknown>) ?? {};
    const fieldName = creds.fieldName as string | undefined;
    const value = result.credentials.access_token ?? result.credentials.api_key;
    if (fieldName && value) {
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
 * Save a connection (upsert on profileId + providerId + orgId).
 */
export async function saveConnection(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
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
      orgId,
      credentialsEncrypted: encrypted,
      scopesGranted: options?.scopesGranted ?? [],
      expiresAt: options?.expiresAt ? new Date(options.expiresAt) : null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        serviceConnections.profileId,
        serviceConnections.providerId,
        serviceConnections.orgId,
      ],
      set: {
        credentialsEncrypted: encrypted,
        scopesGranted: options?.scopesGranted ?? [],
        expiresAt: options?.expiresAt ? new Date(options.expiresAt) : null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Delete all connections for a provider on a profile within an org.
 */
export async function deleteConnection(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
): Promise<void> {
  await db
    .delete(serviceConnections)
    .where(
      and(
        eq(serviceConnections.profileId, profileId),
        eq(serviceConnections.providerId, providerId),
        eq(serviceConnections.orgId, orgId),
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
    orgId: row.orgId,
    credentialsEncrypted: row.credentialsEncrypted,
    scopesGranted: (row.scopesGranted as string[]) ?? [],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt!.toISOString(),
    updatedAt: row.updatedAt!.toISOString(),
  };
}
