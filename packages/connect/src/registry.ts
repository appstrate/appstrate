import { eq, and } from "drizzle-orm";
import { providerConfigs } from "@appstrate/db/schema";
import type { Db } from "@appstrate/db/client";
import type { ProviderDefinition, ProviderConfigRow } from "./types.ts";
import { decrypt } from "./encryption.ts";
import { getEnv } from "@appstrate/env";

export type { Db };

/**
 * Built-in provider definitions.
 * Merged from two sources: file-based (data/providers.json) and env var (SYSTEM_PROVIDERS).
 * Env var entries override file entries with the same ID.
 * Inline clientId/clientSecret are used directly without DB lookup.
 */
let BUILT_IN_PROVIDERS: Map<string, ProviderDefinition> | null = null;

function isValidProvider(p: ProviderDefinition): boolean {
  return !!(p.id && p.displayName && p.authMode);
}

function addProviders(
  map: Map<string, ProviderDefinition>,
  providers: ProviderDefinition[],
  source: string,
  warnOverride = false,
): void {
  for (const p of providers) {
    if (!isValidProvider(p)) {
      console.error(
        `[connect] ${source}: skipping invalid entry (missing id/displayName/authMode)`,
        p,
      );
      continue;
    }
    if (warnOverride && map.has(p.id)) {
      console.warn(`[connect] ${source} overrides file provider '${p.id}'`);
    }
    map.set(p.id, p);
  }
}

function parseEnvProviders(): ProviderDefinition[] {
  const raw = getEnv().SYSTEM_PROVIDERS;
  return raw as ProviderDefinition[];
}

/**
 * Initialize built-in providers from file-based definitions + env var.
 * File providers are loaded first, then env var entries override (with a warning).
 * Call once at boot before any provider lookups.
 */
export function initBuiltInProviders(fileProviders?: ProviderDefinition[]): void {
  const map = new Map<string, ProviderDefinition>();

  if (fileProviders) {
    addProviders(map, fileProviders, "providers.json");
  }
  addProviders(map, parseEnvProviders(), "SYSTEM_PROVIDERS", true);

  BUILT_IN_PROVIDERS = map;
}

/** Ensure providers are initialized (auto-init from env var if initBuiltInProviders was never called). */
function ensureInit(): Map<string, ProviderDefinition> {
  if (!BUILT_IN_PROVIDERS) {
    initBuiltInProviders();
  }
  return BUILT_IN_PROVIDERS!;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Convert a DB row to a ProviderDefinition.
 * Decrypts client_id and client_secret if present.
 */
function rowToDefinition(row: ProviderConfigRow): ProviderDefinition {
  return {
    id: row.id,
    displayName: row.display_name,
    authMode: row.auth_mode,
    authorizationUrl: row.authorization_url ?? undefined,
    tokenUrl: row.token_url ?? undefined,
    refreshUrl: row.refresh_url ?? undefined,
    defaultScopes: row.default_scopes ?? [],
    scopeSeparator: row.scope_separator ?? " ",
    pkceEnabled: row.pkce_enabled ?? true,
    authorizationParams: row.authorization_params ?? {},
    tokenParams: row.token_params ?? {},
    credentialSchema: row.credential_schema ?? undefined,
    credentialFieldName: row.credential_field_name ?? undefined,
    credentialHeaderName: row.credential_header_name ?? undefined,
    credentialHeaderPrefix: row.credential_header_prefix ?? undefined,
    iconUrl: row.icon_url ?? undefined,
    categories: row.categories ?? [],
    docsUrl: row.docs_url ?? undefined,
    authorizedUris: row.authorized_uris?.length ? row.authorized_uris : undefined,
    allowAllUris: row.allow_all_uris ?? false,
    availableScopes: row.available_scopes?.length ? row.available_scopes : undefined,
  };
}

/**
 * Get a provider definition by ID.
 * Built-in providers are immutable — DB rows with the same ID do NOT override them.
 * DB rows are exclusively custom providers (IDs different from built-in).
 */
export async function getProvider(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<ProviderDefinition | null> {
  // Built-in providers always win
  const builtIn = ensureInit().get(providerId);
  if (builtIn) return builtIn;

  // Check DB for custom providers
  const rows = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.orgId, orgId), eq(providerConfigs.id, providerId)))
    .limit(1);

  if (rows.length > 0) return rowToDefinition(rows[0] as unknown as ProviderConfigRow);

  return null;
}

/**
 * Get a provider definition or throw if not found.
 * Optionally validates the auth mode.
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
      `No OAuth credentials configured for provider '${providerId}'. Set SYSTEM_PROVIDERS env var or configure via admin.`,
    );
  }
  return creds;
}

/**
 * Get OAuth client credentials for a provider.
 * 1. Check built-in provider's inline credentials (from SYSTEM_PROVIDERS)
 * 2. Fall back to DB config
 */
export async function getProviderOAuthCredentials(
  db: Db,
  orgId: string,
  providerId: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  // 1. Check built-in provider's inline credentials
  const builtIn = ensureInit().get(providerId);
  if (builtIn?.clientId && builtIn?.clientSecret) {
    return { clientId: builtIn.clientId, clientSecret: builtIn.clientSecret };
  }

  // 2. Check DB config
  const rows = await db
    .select({
      clientIdEncrypted: providerConfigs.clientIdEncrypted,
      clientSecretEncrypted: providerConfigs.clientSecretEncrypted,
    })
    .from(providerConfigs)
    .where(and(eq(providerConfigs.orgId, orgId), eq(providerConfigs.id, providerId)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (!row.clientIdEncrypted || !row.clientSecretEncrypted) return null;

  return {
    clientId: decrypt(row.clientIdEncrypted),
    clientSecret: decrypt(row.clientSecretEncrypted),
  };
}

/**
 * List all available providers (built-in + DB custom).
 * Built-in providers are immutable — DB rows with the same ID are skipped.
 */
export async function listProviders(db: Db, orgId: string): Promise<ProviderDefinition[]> {
  const result = new Map<string, ProviderDefinition>();

  // Start with built-in providers (immutable)
  for (const [id, def] of ensureInit()) {
    result.set(id, def);
  }

  // Add custom providers from DB (skip if ID conflicts with built-in)
  const rows = await db.select().from(providerConfigs).where(eq(providerConfigs.orgId, orgId));

  for (const row of rows as unknown as ProviderConfigRow[]) {
    if (!result.has(row.id)) {
      result.set(row.id, rowToDefinition(row));
    }
  }

  return Array.from(result.values());
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
 * Used to return credentials in the correct format to the sidecar.
 */
export function getCredentialFieldName(provider: ProviderDefinition): string {
  return provider.credentialFieldName ?? (provider.authMode === "api_key" ? "api_key" : "token");
}

/**
 * Get the built-in providers map (for routes and prompt building).
 */
export function getBuiltInProviders(): ReadonlyMap<string, ProviderDefinition> {
  return ensureInit();
}

/**
 * Check if a provider ID is a built-in provider.
 */
export function isBuiltInProvider(providerId: string): boolean {
  return ensureInit().has(providerId);
}
