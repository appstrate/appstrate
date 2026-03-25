import { eq, and, or, isNull } from "drizzle-orm";
import { providerCredentials, packages } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ProviderDefinition } from "./types.ts";
import { decryptCredentials } from "./encryption.ts";
import { buildProviderDefinitionFromManifest } from "@appstrate/core/validation";

export type { Db };

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
      draftContent: packages.draftContent,
    })
    .from(packages)
    .where(and(eq(packages.id, providerId), or(eq(packages.orgId, orgId), isNull(packages.orgId))))
    .limit(1);

  if (rows.length === 0) return null;
  const pkg = rows[0]!;
  const resolved = buildProviderDefinitionFromManifest(
    pkg.id,
    (pkg.draftManifest ?? {}) as Record<string, unknown>,
  );
  const content = pkg.draftContent?.trim() ?? "";
  return {
    ...resolved,
    hasProviderDoc: content.length > 0 && !content.startsWith("{"),
  };
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
 * Get OAuth client credentials for a provider.
 * Reads from providerCredentials (keyed by providerId + orgId).
 */
/**
 * Get raw decrypted admin credentials for a provider.
 */
async function getProviderAdminCredentials(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<Record<string, string> | null> {
  const credRows = await db
    .select({
      credentialsEncrypted: providerCredentials.credentialsEncrypted,
    })
    .from(providerCredentials)
    .where(
      and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.orgId, orgId)),
    )
    .limit(1);

  if (credRows.length === 0) return null;
  const row = credRows[0]!;
  if (!row.credentialsEncrypted) return null;

  return decryptCredentials<Record<string, string>>(row.credentialsEncrypted);
}

export async function getProviderOAuthCredentials(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const creds = await getProviderAdminCredentials(db, orgId, providerId);
  if (!creds?.clientId || !creds?.clientSecret) return null;

  return {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  };
}

/**
 * Get OAuth client credentials for a provider or throw if not configured.
 */
export async function getProviderOAuthCredentialsOrThrow(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const creds = await getProviderOAuthCredentials(db, orgId, providerId);
  if (!creds) {
    throw new Error(
      `No OAuth credentials configured for provider '${providerId}'. Configure via admin settings.`,
    );
  }
  return creds;
}

/**
 * Get OAuth1 consumer credentials for a provider or throw if not configured.
 * Reads consumerKey/consumerSecret directly from the credentials JSON blob.
 */
export async function getProviderOAuth1CredentialsOrThrow(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<{ consumerKey: string; consumerSecret: string }> {
  const creds = await getProviderAdminCredentials(db, orgId, providerId);
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
    .where(
      and(eq(packages.type, "provider"), or(eq(packages.orgId, orgId), isNull(packages.orgId))),
    );

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
  return provider.credentialFieldName ?? (provider.authMode === "api_key" ? "api_key" : "token");
}

/**
 * Check if a provider is enabled for an org.
 */
export async function isProviderEnabled(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<boolean> {
  const rows = await db
    .select({ enabled: providerCredentials.enabled })
    .from(providerCredentials)
    .where(
      and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.orgId, orgId)),
    )
    .limit(1);
  return rows.length > 0 && !!rows[0]!.enabled;
}

