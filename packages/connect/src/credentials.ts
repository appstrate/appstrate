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

// `ProxyCredentialsPayload` is declared in `./proxy-primitives.ts` so
// both the DB-backed platform path and the HTTP-backed sidecar (which
// cannot import @appstrate/db) share a single type definition.
export type { ProxyCredentialsPayload } from "./proxy-primitives.ts";
import type { ProxyCredentialsPayload } from "./proxy-primitives.ts";

/**
 * Resolve credentials for the sidecar proxy.
 * Reads authorizedUris and transport metadata from
 * `packages.manifest.definition`.
 */
export async function resolveCredentialsForProxy(
  db: Db,
  profileId: string,
  providerId: string,
  orgId: string,
  providerCredentialId: string,
): Promise<ProxyCredentialsPayload | null> {
  const result = await getCredentials(db, profileId, providerId, orgId, providerCredentialId);
  if (!result) return null;

  const def = result.definition;
  const authMode = def.authMode as AuthMode | undefined;

  return {
    credentials: buildSidecarCredentials(result.credentials, def, authMode),
    ...extractUriConfig(def),
    ...extractInjection(def, authMode),
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
): Promise<ProxyCredentialsPayload | null> {
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
    ...extractInjection(def, authMode),
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
    /**
     * Initial value for the `needsReconnection` flag. Defaults to `false`
     * (a fresh OAuth callback grants a working connection). Callers that
     * detect a scope shortfall can pass `true` here to make the insert
     * atomic — without this option, a separate UPDATE follows the INSERT
     * and any consumer reading between the two queries sees a brief
     * "connected with full scopes" window that disappears once the flag
     * flips. Atomic upsert eliminates that window.
     */
    needsReconnection?: boolean;
  },
): Promise<void> {
  const encrypted = encryptCredentials(credentials);

  const connectionData = {
    credentialsEncrypted: encrypted,
    scopesGranted: options.scopesGranted ?? [],
    expiresAt: options.expiresAt ? new Date(options.expiresAt) : null,
    needsReconnection: options.needsReconnection ?? false,
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
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => credentials[key] ?? "");
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
 * Map decrypted credentials to the sidecar format.
 *
 * For `api_key` providers with a `credentialTransform`, the transform's template
 * is rendered with `{{var}}` substitution and the result passed through the
 * declared encoding. The transformed value replaces `credentials.fieldName`;
 * other credential fields (subdomain, email, …) are preserved so they stay
 * available for URL and header substitution downstream in the sidecar.
 *
 * For OAuth2 / api_key without a transform, the value is mapped to a single
 * `{ [fieldName]: value }` variable.
 *
 * @internal Exported for direct unit testing — not part of the public API.
 */
export function buildSidecarCredentials(
  credentials: Record<string, string>,
  def: Record<string, unknown>,
  authMode: AuthMode | undefined,
): Record<string, string> {
  if (authMode === "api_key") {
    const transform = def.credentialTransform as CredentialTransform | undefined;
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

/**
 * Extract the transport-injection metadata that lets the sidecar (and the
 * `/api/credential-proxy/proxy` route) write the upstream auth header
 * server-side without the agent ever touching placeholders.
 *
 * `credentialHeaderName` / `credentialHeaderPrefix` come from the
 * definition root (spec §7.5 — cross-cutting transport fields).
 * `credentialFieldName` is the resolved name of the field inside the
 * sidecar credentials map that holds the secret — `access_token` for
 * OAuth flows, `api_key` for API-key flows, or an explicit manifest
 * override via `definition.credentials.fieldName`.
 *
 * For auth modes that don't map to a single secret (basic, custom), we
 * still return a field name (the default) so downstream code can treat
 * the presence of `credentialHeaderName` as the single switch that
 * controls injection.
 */
function extractInjection(
  def: Record<string, unknown>,
  authMode: AuthMode | undefined,
): {
  credentialHeaderName?: string;
  credentialHeaderPrefix?: string;
  credentialFieldName: string;
} {
  const headerName = def.credentialHeaderName;
  const headerPrefix = def.credentialHeaderPrefix;
  const creds = (def.credentials as Record<string, unknown> | undefined) ?? {};
  const explicitField = creds.fieldName;
  const credentialFieldName =
    typeof explicitField === "string" && explicitField.length > 0
      ? explicitField
      : authMode === "api_key"
        ? "api_key"
        : "access_token";
  return {
    credentialHeaderName:
      typeof headerName === "string" && headerName.length > 0 ? headerName : undefined,
    credentialHeaderPrefix: typeof headerPrefix === "string" ? headerPrefix : undefined,
    credentialFieldName,
  };
}
