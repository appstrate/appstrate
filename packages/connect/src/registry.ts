import type { SupabaseClient as _SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@appstrate/shared-types";
import type { ProviderDefinition, ProviderConfigRow } from "./types.ts";
import { decrypt } from "./encryption.ts";

export type SupabaseClient = _SupabaseClient<Database>;

/**
 * Built-in provider definitions.
 * Loaded from SYSTEM_PROVIDERS env var (JSON array). Empty map if not set.
 * Inline clientId/clientSecret are used directly without DB lookup.
 */
let BUILT_IN_PROVIDERS: Map<string, ProviderDefinition>;

if (process.env.SYSTEM_PROVIDERS) {
  try {
    const parsed = JSON.parse(process.env.SYSTEM_PROVIDERS) as ProviderDefinition[];
    if (!Array.isArray(parsed)) throw new Error("SYSTEM_PROVIDERS must be a JSON array");
    BUILT_IN_PROVIDERS = new Map<string, ProviderDefinition>();
    for (const p of parsed) {
      if (!p.id || !p.displayName || !p.authMode) {
        console.error(
          `[connect] SYSTEM_PROVIDERS: skipping invalid entry (missing id/displayName/authMode)`,
          p,
        );
        continue;
      }
      BUILT_IN_PROVIDERS.set(p.id, p);
    }
  } catch (err) {
    console.error("[connect] Failed to parse SYSTEM_PROVIDERS:", err);
    BUILT_IN_PROVIDERS = new Map();
  }
} else {
  BUILT_IN_PROVIDERS = new Map();
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
  };
}

/**
 * Get a provider definition by ID.
 * Built-in providers are immutable — DB rows with the same ID do NOT override them.
 * DB rows are exclusively custom providers (IDs different from built-in).
 */
export async function getProvider(
  supabase: SupabaseClient,
  orgId: string,
  providerId: string,
): Promise<ProviderDefinition | null> {
  // Built-in providers always win
  const builtIn = BUILT_IN_PROVIDERS.get(providerId);
  if (builtIn) return builtIn;

  // Check DB for custom providers
  const { data: row } = await supabase
    .from("provider_configs")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", providerId)
    .single();

  if (row) return rowToDefinition(row as unknown as ProviderConfigRow);

  return null;
}

/**
 * Get a provider definition or throw if not found.
 * Optionally validates the auth mode.
 */
export async function getProviderOrThrow(
  supabase: SupabaseClient,
  orgId: string,
  providerId: string,
  expectedAuthMode?: string,
): Promise<ProviderDefinition> {
  const provider = await getProvider(supabase, orgId, providerId);
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
  supabase: SupabaseClient,
  orgId: string,
  providerId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const creds = await getProviderOAuthCredentials(supabase, orgId, providerId);
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
  supabase: SupabaseClient,
  orgId: string,
  providerId: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  // 1. Check built-in provider's inline credentials
  const builtIn = BUILT_IN_PROVIDERS.get(providerId);
  if (builtIn?.clientId && builtIn?.clientSecret) {
    return { clientId: builtIn.clientId, clientSecret: builtIn.clientSecret };
  }

  // 2. Check DB config
  const { data: row } = await supabase
    .from("provider_configs")
    .select("client_id_encrypted,client_secret_encrypted")
    .eq("org_id", orgId)
    .eq("id", providerId)
    .single();

  if (!row) return null;
  const typedRow = row as {
    client_id_encrypted: string | null;
    client_secret_encrypted: string | null;
  };
  if (!typedRow.client_id_encrypted || !typedRow.client_secret_encrypted) return null;

  return {
    clientId: decrypt(typedRow.client_id_encrypted),
    clientSecret: decrypt(typedRow.client_secret_encrypted),
  };
}

/**
 * List all available providers (built-in + DB custom).
 * Built-in providers are immutable — DB rows with the same ID are skipped.
 */
export async function listProviders(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ProviderDefinition[]> {
  const result = new Map<string, ProviderDefinition>();

  // Start with built-in providers (immutable)
  for (const [id, def] of BUILT_IN_PROVIDERS) {
    result.set(id, def);
  }

  // Add custom providers from DB (skip if ID conflicts with built-in)
  const { data: rows } = await supabase.from("provider_configs").select("*").eq("org_id", orgId);

  if (rows) {
    for (const row of rows as unknown as ProviderConfigRow[]) {
      if (!result.has(row.id)) {
        result.set(row.id, rowToDefinition(row));
      }
    }
  }

  return Array.from(result.values());
}

/**
 * Get the auth mode for a provider.
 */
export async function getProviderAuthMode(
  supabase: SupabaseClient,
  orgId: string,
  providerId: string,
): Promise<string | undefined> {
  const provider = await getProvider(supabase, orgId, providerId);
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
  return BUILT_IN_PROVIDERS;
}

/**
 * Check if a provider ID is a built-in provider.
 */
export function isBuiltInProvider(providerId: string): boolean {
  return BUILT_IN_PROVIDERS.has(providerId);
}
