import type { JSONSchemaObject } from "@appstrate/shared-types";

export type AuthMode = "oauth2" | "api_key" | "basic" | "custom";

export interface ProviderDefinition {
  id: string;
  displayName: string;
  authMode: AuthMode;
  // OAuth2
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string; // defaults to tokenUrl
  defaultScopes?: string[];
  scopeSeparator?: string; // " " | "," | "+"
  pkceEnabled?: boolean; // default true
  authorizationParams?: Record<string, string>; // access_type, prompt, etc.
  tokenParams?: Record<string, string>;
  // Credential schema (API_KEY, BASIC, CUSTOM)
  credentialSchema?: JSONSchemaObject;
  // Proxy/API
  credentialFieldName?: string; // "token" | "api_key" etc. — how the credential is named when returned
  credentialHeaderName?: string; // "Authorization" | "api-key" etc. — header name for injection
  credentialHeaderPrefix?: string; // "Bearer " | "" etc.
  // Inline OAuth credentials (from SYSTEM_PROVIDERS env var)
  clientId?: string;
  clientSecret?: string;
  // URI restrictions (for sidecar proxy)
  authorizedUris?: string[];
  allowAllUris?: boolean;
  // Meta
  iconUrl?: string;
  categories?: string[];
  docsUrl?: string;
}

export interface ConnectionRecord {
  id: string;
  orgId: string;
  userId: string;
  providerId: string;
  flowId: string | null;
  authMode: AuthMode;
  credentialsEncrypted: string;
  scopesGranted: string[];
  expiresAt: string | null;
  rawTokenResponse: Record<string, unknown> | null;
  connectionConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedCredentials {
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  username?: string;
  password?: string;
  [key: string]: string | undefined;
}

export interface OAuthStateRecord {
  state: string;
  orgId: string;
  userId: string;
  providerId: string;
  codeVerifier: string;
  scopesRequested: string[];
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
}

export interface ProviderConfigRow {
  id: string;
  org_id: string;
  auth_mode: AuthMode;
  display_name: string;
  client_id_encrypted: string | null;
  client_secret_encrypted: string | null;
  authorization_url: string | null;
  token_url: string | null;
  refresh_url: string | null;
  default_scopes: string[];
  scope_separator: string;
  pkce_enabled: boolean;
  authorization_params: Record<string, string>;
  token_params: Record<string, string>;
  credential_schema: JSONSchemaObject | null;
  credential_field_name: string | null;
  credential_header_name: string | null;
  credential_header_prefix: string | null;
  icon_url: string | null;
  categories: string[];
  docs_url: string | null;
  authorized_uris: string[];
  allow_all_uris: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScopeValidationResult {
  sufficient: boolean;
  granted: string[];
  required: string[];
  missing: string[];
}
