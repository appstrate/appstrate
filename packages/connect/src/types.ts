import type { JSONSchemaObject, AvailableScope } from "@appstrate/shared-types";

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
  // Scopes
  availableScopes?: AvailableScope[];
  // Meta
  iconUrl?: string;
  categories?: string[];
  docsUrl?: string;
}

export interface ProviderSnapshot {
  authMode: AuthMode;
  tokenUrl?: string;
  refreshUrl?: string;
  clientIdEncrypted?: string;
  clientSecretEncrypted?: string;
  scopeSeparator?: string;
  credentialFieldName?: string;
  credentialHeaderName?: string;
  credentialHeaderPrefix?: string;
  authorizedUris?: string[];
  allowAllUris?: boolean;
}

export interface ConnectionRecord {
  id: string;
  profileId: string;
  providerId: string;
  authMode: AuthMode;
  credentialsEncrypted: string;
  scopesGranted: string[];
  expiresAt: string | null;
  rawTokenResponse: Record<string, unknown> | null;
  providerSnapshot: ProviderSnapshot;
  configHash: string;
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
  profileId: string;
  providerId: string;
  codeVerifier: string;
  scopesRequested: string[];
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
}

export interface ScopeValidationResult {
  sufficient: boolean;
  granted: string[];
  required: string[];
  missing: string[];
}
