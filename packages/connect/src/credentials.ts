// SPDX-License-Identifier: Apache-2.0

import { eq, and } from "drizzle-orm";
import {
  userProviderConnections,
  applicationProviderCredentials,
  packages,
} from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ConnectionRecord, DecryptedCredentials } from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { refreshIfNeeded, forceRefresh, type RefreshContext } from "./token-refresh.ts";

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
    .from(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.profileId, profileId),
        eq(userProviderConnections.providerId, providerId),
        eq(userProviderConnections.orgId, orgId),
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
    .from(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.profileId, profileId),
        eq(userProviderConnections.orgId, orgId),
      ),
    );

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
 * Get decrypted credentials for a provider.
 * Handles token refresh for OAuth2 connections by looking up provider
 * definition and credentials from the DB.
 */
export async function getCredentials(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
  applicationId: string,
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
    const refreshContext = await buildRefreshContext(db, def, providerId, orgId, applicationId);
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
  applicationId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const result = await getCredentials(db, profileId, providerId, orgId, applicationId);
  if (!result) return null;

  const def = result.definition;
  const authMode = def.authMode as string | undefined;

  return {
    credentials: buildSidecarCredentials(result.credentials, def, authMode),
    ...extractUriConfig(def),
  };
}

/**
 * Force-refresh credentials for a provider connection and return the updated proxy credentials.
 * Used by the sidecar retry-on-401 flow. If the provider is not OAuth2 or has no refresh token,
 * returns the current credentials unchanged (no error).
 * Throws if the refresh request itself fails (invalid_grant, network error, etc.).
 */
export async function forceRefreshCredentials(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
  applicationId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const connection = await getConnection(db, profileId, providerId, orgId);
  if (!connection) return null;

  const def = await getProviderDefinition(db, providerId);
  const authMode = def.authMode as string | undefined;

  let decrypted: DecryptedCredentials;

  if (authMode === "oauth2") {
    const refreshContext = await buildRefreshContext(db, def, providerId, orgId, applicationId);
    decrypted = await forceRefresh(
      db,
      connection.id,
      connection.providerId,
      connection.credentialsEncrypted,
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

  return {
    credentials: buildSidecarCredentials(credentials, def, authMode),
    ...extractUriConfig(def),
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

  const connectionData = {
    credentialsEncrypted: encrypted,
    scopesGranted: options?.scopesGranted ?? [],
    expiresAt: options?.expiresAt ? new Date(options.expiresAt) : null,
    needsReconnection: false,
  };

  await db
    .insert(userProviderConnections)
    .values({
      profileId,
      providerId,
      orgId,
      ...connectionData,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        userProviderConnections.profileId,
        userProviderConnections.providerId,
        userProviderConnections.orgId,
      ],
      set: {
        ...connectionData,
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
    .delete(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.profileId, profileId),
        eq(userProviderConnections.providerId, providerId),
        eq(userProviderConnections.orgId, orgId),
      ),
    );
}

/**
 * Delete a single connection by its ID.
 */
export async function deleteConnectionById(db: Db, connectionId: string): Promise<void> {
  await db.delete(userProviderConnections).where(eq(userProviderConnections.id, connectionId));
}

// --- Internal helpers ---

function rowToConnection(row: typeof userProviderConnections.$inferSelect): ConnectionRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    providerId: row.providerId,
    orgId: row.orgId,
    credentialsEncrypted: row.credentialsEncrypted,
    scopesGranted: (row.scopesGranted as string[]) ?? [],
    needsReconnection: row.needsReconnection,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt!.toISOString(),
    updatedAt: row.updatedAt!.toISOString(),
  };
}

/** Build OAuth2 refresh context from provider definition and admin credentials.
 * Queries applicationProviderCredentials keyed by (applicationId, providerId). */
async function buildRefreshContext(
  db: Db,
  def: Record<string, unknown>,
  providerId: string,
  _orgId: string,
  applicationId: string,
): Promise<RefreshContext | undefined> {
  const oauth2 = (def.oauth2 as Record<string, unknown>) ?? {};
  const tokenUrl = (oauth2.refreshUrl as string) ?? (oauth2.tokenUrl as string);
  if (!tokenUrl) return undefined;

  const [appRow] = await db
    .select({ credentialsEncrypted: applicationProviderCredentials.credentialsEncrypted })
    .from(applicationProviderCredentials)
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.providerId, providerId),
      ),
    )
    .limit(1);

  if (!appRow?.credentialsEncrypted) return undefined;
  const adminCreds = decryptCredentials<Record<string, string>>(appRow.credentialsEncrypted);

  if (!adminCreds.clientId || !adminCreds.clientSecret) return undefined;

  return {
    tokenUrl,
    clientId: adminCreds.clientId,
    clientSecret: adminCreds.clientSecret,
    tokenAuthMethod: (oauth2.tokenAuthMethod as string) ?? undefined,
    scopeSeparator: (oauth2.scopeSeparator as string) ?? undefined,
  };
}

/** Map decrypted credentials to the sidecar format (single named field for oauth2/api_key). */
function buildSidecarCredentials(
  credentials: Record<string, string>,
  def: Record<string, unknown>,
  authMode: string | undefined,
): Record<string, string> {
  if (authMode === "oauth2" || authMode === "api_key") {
    const creds = (def.credentials as Record<string, unknown>) ?? {};
    const fieldName = creds.fieldName as string | undefined;
    const value = credentials.access_token ?? credentials.api_key;
    if (fieldName && value) {
      return { [fieldName]: value };
    }
  }
  return credentials;
}

/** Extract authorizedUris and allowAllUris from provider definition. */
function extractUriConfig(def: Record<string, unknown>): {
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} {
  const authorizedUris = (def.authorizedUris as string[])?.length
    ? (def.authorizedUris as string[])
    : null;
  const allowAllUris = (def.allowAllUris as boolean) ?? false;
  return { authorizedUris, allowAllUris };
}
