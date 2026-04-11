// SPDX-License-Identifier: Apache-2.0

import { eq, and, inArray } from "drizzle-orm";
import {
  userProviderConnections,
  applicationProviderCredentials,
  packages,
} from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ConnectionRecord, DecryptedCredentials } from "./types.ts";
import { encryptCredentials, decryptCredentials } from "./encryption.ts";
import { forceRefresh, type RefreshContext } from "./token-refresh.ts";
import type {
  AuthMode,
  CredentialEncoding,
  CredentialTransform,
  OAuthTokenAuthMethod,
  OAuthTokenContentType,
} from "@appstrate/core/validation";

/**
 * Get a connection by profile + provider + org + provider credential.
 * Returns the connection created with the given application provider credential.
 */
export async function getConnection(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
  providerCredentialId: string,
): Promise<ConnectionRecord | null> {
  const conditions = [
    eq(userProviderConnections.profileId, profileId),
    eq(userProviderConnections.providerId, providerId),
    eq(userProviderConnections.orgId, orgId),
    eq(userProviderConnections.providerCredentialId, providerCredentialId),
  ];

  const rows = await db
    .select()
    .from(userProviderConnections)
    .where(and(...conditions))
    .limit(1);

  if (rows.length === 0) return null;
  return rowToConnection(rows[0]!);
}

/**
 * List connections for a profile within an org.
 * Only connections created with the given application credentials are returned (per-app isolation).
 */
export async function listConnections(
  db: Db,
  profileId: string,
  orgId: string,
  providerCredentialIds: string[],
): Promise<ConnectionRecord[]> {
  if (providerCredentialIds.length === 0) return [];

  const rows = await db
    .select()
    .from(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.profileId, profileId),
        eq(userProviderConnections.orgId, orgId),
        inArray(userProviderConnections.providerCredentialId, providerCredentialIds),
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
  providerCredentialId: string,
): Promise<{
  credentials: Record<string, string>;
  connection: ConnectionRecord;
  definition: Record<string, unknown>;
} | null> {
  const connection = await getConnection(db, profileId, providerId, orgId, providerCredentialId);
  if (!connection) return null;

  const def = await getProviderDefinition(db, providerId);

  // Return current credentials as-is. The sidecar handles 401 → refresh → retry.
  const decrypted = decryptCredentials<DecryptedCredentials>(connection.credentialsEncrypted);

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
  providerCredentialId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const result = await getCredentials(db, profileId, providerId, orgId, providerCredentialId);
  if (!result) return null;

  const def = result.definition;
  const authMode = def.authMode as AuthMode | undefined;

  return {
    credentials: buildSidecarCredentials(result.credentials, def, authMode),
    ...extractUriConfig(def),
  };
}

/**
 * Force-refresh credentials for a provider connection and return the updated proxy credentials.
 * Uses the connection's providerCredentialId to look up the admin credentials that created it.
 * Throws if the refresh request itself fails (invalid_grant, network error, etc.).
 */
export async function forceRefreshCredentials(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
  providerCredentialId: string,
): Promise<{
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
} | null> {
  const connection = await getConnection(db, profileId, providerId, orgId, providerCredentialId);
  if (!connection) return null;

  const def = await getProviderDefinition(db, providerId);
  const authMode = def.authMode as AuthMode | undefined;

  let decrypted: DecryptedCredentials;

  if (authMode === "oauth2") {
    const refreshContext = await buildRefreshContext(db, def, connection.providerCredentialId);
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
 * Save a connection (upsert on profileId + providerId + orgId + providerCredentialId).
 */
export async function saveConnection(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
  credentials: Record<string, unknown>,
  options: {
    providerCredentialId: string;
    scopesGranted?: string[];
    expiresAt?: string | null;
  },
): Promise<void> {
  const encrypted = encryptCredentials(credentials);

  const connectionData = {
    credentialsEncrypted: encrypted,
    scopesGranted: options.scopesGranted ?? [],
    expiresAt: options.expiresAt ? new Date(options.expiresAt) : null,
    needsReconnection: false,
    providerCredentialId: options.providerCredentialId,
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
        userProviderConnections.providerCredentialId,
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
  providerCredentialId: string,
): Promise<void> {
  await db
    .delete(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.profileId, profileId),
        eq(userProviderConnections.providerId, providerId),
        eq(userProviderConnections.orgId, orgId),
        eq(userProviderConnections.providerCredentialId, providerCredentialId),
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
    providerCredentialId: row.providerCredentialId,
    credentialsEncrypted: row.credentialsEncrypted,
    scopesGranted: (row.scopesGranted as string[]) ?? [],
    needsReconnection: row.needsReconnection,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt!.toISOString(),
    updatedAt: row.updatedAt!.toISOString(),
  };
}

/**
 * List all credential IDs for a given application.
 * Used to scope connection queries to a specific app.
 */
export async function listProviderCredentialIds(db: Db, applicationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: applicationProviderCredentials.id })
    .from(applicationProviderCredentials)
    .where(eq(applicationProviderCredentials.applicationId, applicationId));
  return rows.map((r) => r.id);
}

/**
 * List provider IDs that have enabled credentials configured for an application.
 */
export async function listConfiguredProviderIds(db: Db, applicationId: string): Promise<string[]> {
  const rows = await db
    .select({ providerId: applicationProviderCredentials.providerId })
    .from(applicationProviderCredentials)
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.enabled, true),
      ),
    );
  return rows.map((r) => r.providerId);
}

/**
 * Look up the `applicationProviderCredentials.id` for a given (applicationId, providerId).
 * Returns null if no row exists.
 */
export async function getProviderCredentialId(
  db: Db,
  applicationId: string,
  providerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: applicationProviderCredentials.id })
    .from(applicationProviderCredentials)
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.providerId, providerId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Build OAuth2 refresh context from the connection's source admin credentials. */
async function buildRefreshContext(
  db: Db,
  def: Record<string, unknown>,
  providerCredentialId: string,
): Promise<RefreshContext | undefined> {
  const oauth2 = (def.oauth2 as Record<string, unknown>) ?? {};
  const tokenUrl = (oauth2.refreshUrl as string) ?? (oauth2.tokenUrl as string);
  if (!tokenUrl) return undefined;

  const [appRow] = await db
    .select({ credentialsEncrypted: applicationProviderCredentials.credentialsEncrypted })
    .from(applicationProviderCredentials)
    .where(eq(applicationProviderCredentials.id, providerCredentialId))
    .limit(1);

  if (!appRow?.credentialsEncrypted) return undefined;
  const adminCreds = decryptCredentials<Record<string, string>>(appRow.credentialsEncrypted);

  if (!adminCreds.clientId || !adminCreds.clientSecret) return undefined;

  return {
    tokenUrl,
    clientId: adminCreds.clientId,
    clientSecret: adminCreds.clientSecret,
    tokenAuthMethod: (oauth2.tokenAuthMethod as OAuthTokenAuthMethod) ?? undefined,
    scopeSeparator: (oauth2.scopeSeparator as string) ?? undefined,
    tokenContentType: (oauth2.tokenContentType as OAuthTokenContentType) ?? undefined,
  };
}

/** Render `{{var}}` placeholders using the given credential fields. Unknown refs become empty. */
function substituteTemplate(template: string, credentials: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => credentials[key] ?? "");
}

/** Apply a whitelisted post-substitution transform. Throws on unknown encodings. */
function applyTransformEncoding(value: string, encoding: CredentialTransform["encoding"]): string {
  if (encoding === "base64") return Buffer.from(value, "utf8").toString("base64");
  // Exhaustiveness guard — new AFPS encodings must be wired here explicitly.
  throw new Error(`Unsupported credentialTransform encoding: ${encoding as string}`);
}

/**
 * Evaluate {@link CredentialTransform} against a credential set. Returns the
 * transformed value, or `null` if the template references a missing field (in
 * which case the caller should fall through to the standard `fieldName` mapping).
 */
function evaluateCredentialTransform(
  transform: CredentialTransform,
  credentials: Record<string, string>,
): string | null {
  const refs = [...transform.template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
  for (const ref of refs) {
    if (!credentials[ref]) return null;
  }
  return applyTransformEncoding(
    substituteTemplate(transform.template, credentials),
    transform.encoding,
  );
}

/**
 * Translate {@link CredentialEncoding} into an equivalent {@link CredentialTransform}.
 * Used for backward compatibility with AFPS <= 1.2.2 manifests; should be
 * removed once all system providers have migrated to `credentialTransform`.
 *
 * @deprecated Remove once {@link CredentialEncoding} is dropped from AFPS.
 */
function legacyEncodingToTransform(
  encoding: CredentialEncoding | undefined,
): CredentialTransform | undefined {
  if (encoding === "basic_api_key_x") {
    return { template: "{{api_key}}:X", encoding: "base64" };
  }
  if (encoding === "basic_email_token") {
    return { template: "{{email}}/token:{{api_key}}", encoding: "base64" };
  }
  return undefined;
}

/**
 * Map decrypted credentials to the sidecar format.
 *
 * For `api_key` providers with a `credentialTransform`, the transform's template
 * is rendered with `{{var}}` substitution and the result passed through the
 * declared encoding. The transformed value replaces `credentials.fieldName`;
 * other credential fields (subdomain, email, …) are preserved so they stay
 * available for URL and header substitution downstream in the sidecar.
 *
 * The legacy `credentialEncoding` enum (AFPS <= 1.2.2) is honored by
 * translating it into an equivalent `credentialTransform` and reusing the
 * same code path. `credentialTransform` wins when both are present.
 *
 * For OAuth2 / api_key without any transform, the value is mapped to a single
 * `{ [fieldName]: value }` variable — this matches the prior behavior.
 *
 * @internal Exported for direct unit testing — not part of the public API.
 */
export function buildSidecarCredentials(
  credentials: Record<string, string>,
  def: Record<string, unknown>,
  authMode: AuthMode | undefined,
): Record<string, string> {
  if (authMode === "api_key") {
    // credentialTransform wins over the deprecated credentialEncoding.
    const transform =
      (def.credentialTransform as CredentialTransform | undefined) ??
      legacyEncodingToTransform(def.credentialEncoding as CredentialEncoding | undefined);

    if (transform) {
      const encoded = evaluateCredentialTransform(transform, credentials);
      if (encoded !== null) {
        const fieldName =
          ((def.credentials as Record<string, unknown>)?.fieldName as string | undefined) ??
          "api_key";
        return { ...credentials, [fieldName]: encoded };
      }
      // Fall through: template referenced a missing field (e.g. Zendesk without email).
    }
  }

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
