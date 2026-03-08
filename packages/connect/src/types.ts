import type { JSONSchemaObject, AvailableScope, AuthMode } from "@appstrate/shared-types";

export type { AuthMode };

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
  authorizationParams?: Record<string, string>; // OAuth2: access_type, prompt; OAuth1: name, scope, expiration
  tokenParams?: Record<string, string>;
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic"; // default: client_secret_post
  // Credential schema (API_KEY, BASIC, CUSTOM)
  credentialSchema?: JSONSchemaObject;
  // Proxy/API
  credentialFieldName?: string; // "token" | "api_key" etc. — how the credential is named when returned
  credentialHeaderName?: string; // "Authorization" | "api-key" etc. — header name for injection
  credentialHeaderPrefix?: string; // "Bearer " | "" etc.
  // OAuth1
  requestTokenUrl?: string;
  accessTokenUrl?: string;
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

export interface ConnectionRecord {
  id: string;
  profileId: string;
  providerId: string;
  credentialsEncrypted: string;
  scopesGranted: string[];
  expiresAt: string | null;
  rawTokenResponse: Record<string, unknown> | null;
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
  authMode: string;
  oauthTokenSecret?: string;
}

export interface ScopeValidationResult {
  sufficient: boolean;
  granted: string[];
  required: string[];
  missing: string[];
}
