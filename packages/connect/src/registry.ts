// SPDX-License-Identifier: Apache-2.0

import { eq, and, or, isNull } from "drizzle-orm";
import { applicationProviderCredentials, packages } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ProviderDefinition } from "./types.ts";
import { decryptCredentials } from "./encryption.ts";
import { buildProviderDefinitionFromManifest } from "@appstrate/core/validation";

/** Drizzle filter: packages owned by org OR system packages (orgId: null). */
function orgOrSystemFilter(orgId: string) {
  return or(eq(packages.orgId, orgId), isNull(packages.orgId))!;
}

/**
 * Get a provider definition by ID.
 * Queries packages where type="provider".
 */
export async function getProvider(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<ProviderDefinition | null> {
  const rows = await db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(and(eq(packages.id, providerId), orgOrSystemFilter(orgId)))
    .limit(1);

  if (rows.length === 0) return null;
  const pkg = rows[0]!;
  return buildProviderDefinitionFromManifest(
    pkg.id,
    (pkg.draftManifest ?? {}) as Record<string, unknown>,
  );
}

/**
 * Get a provider definition or throw if not found.
 */
export async function getProviderOrThrow(
  db: Db,
  orgId: string,
  providerId: string,
  expectedAuthMode?: string,
): Promise<ProviderDefinition> {
  const provider = await getProvider(db, orgId, providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' not found`);
  }
  if (expectedAuthMode && provider.authMode !== expectedAuthMode) {
    throw new Error(`Provider '${providerId}' is not an ${expectedAuthMode} provider`);
  }
  return provider;
}

/**
 * Get raw decrypted admin credentials for a provider.
 * Queries applicationProviderCredentials keyed by (applicationId, providerId).
 */
async function getProviderAdminCredentials(
  db: Db,
  providerId: string,
  applicationId: string,
): Promise<Record<string, string> | null> {
  const [appRow] = await db
    .select({
      credentialsEncrypted: applicationProviderCredentials.credentialsEncrypted,
    })
    .from(applicationProviderCredentials)
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.providerId, providerId),
      ),
    )
    .limit(1);
  if (!appRow?.credentialsEncrypted) return null;
  return decryptCredentials<Record<string, string>>(appRow.credentialsEncrypted);
}

/**
 * Get OAuth client credentials for a provider or throw if not configured.
 */
export async function getProviderOAuthCredentialsOrThrow(
  db: Db,
  providerId: string,
  applicationId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const creds = await getProviderAdminCredentials(db, providerId, applicationId);
  if (!creds?.clientId || !creds?.clientSecret) {
    throw new Error(
      `No OAuth credentials configured for provider '${providerId}'. Configure via admin settings.`,
    );
  }
  return { clientId: creds.clientId, clientSecret: creds.clientSecret };
}

/**
 * Get OAuth1 consumer credentials for a provider or throw if not configured.
 * Reads consumerKey/consumerSecret directly from the credentials JSON blob.
 */
export async function getProviderOAuth1CredentialsOrThrow(
  db: Db,
  providerId: string,
  applicationId: string,
): Promise<{ consumerKey: string; consumerSecret: string }> {
  const creds = await getProviderAdminCredentials(db, providerId, applicationId);
  if (!creds?.consumerKey || !creds?.consumerSecret) {
    throw new Error(
      `No OAuth1 consumer credentials configured for provider '${providerId}'. Configure via admin settings.`,
    );
  }
  return { consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret };
}

/**
 * List all available providers for an org.
 * Queries packages where type="provider".
 */
export async function listProviders(db: Db, orgId: string): Promise<ProviderDefinition[]> {
  const rows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(and(eq(packages.type, "provider"), orgOrSystemFilter(orgId)));

  return rows.map((pkg) =>
    buildProviderDefinitionFromManifest(
      pkg.id,
      (pkg.draftManifest ?? {}) as Record<string, unknown>,
    ),
  );
}

/**
 * Get the auth mode for a provider.
 */
export async function getProviderAuthMode(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<string | undefined> {
  const provider = await getProvider(db, orgId, providerId);
  return provider?.authMode;
}

/**
 * Get the default authorized URIs for a provider.
 */
export function getDefaultAuthorizedUris(provider: ProviderDefinition): string[] | null {
  return provider.authorizedUris?.length ? provider.authorizedUris : null;
}

/**
 * Get the credential field name for a provider.
 */
export function getCredentialFieldName(provider: ProviderDefinition): string {
  return (
    provider.credentialFieldName ?? (provider.authMode === "api_key" ? "api_key" : "access_token")
  );
}

/**
 * Check if a provider is enabled for an application.
 * Queries applicationProviderCredentials keyed by (applicationId, providerId).
 * Returns false if no row exists.
 */
export async function isProviderEnabled(
  db: Db,
  providerId: string,
  applicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: applicationProviderCredentials.enabled })
    .from(applicationProviderCredentials)
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.providerId, providerId),
      ),
    )
    .limit(1);

  return row ? row.enabled : false;
}
