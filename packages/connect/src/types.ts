import type { AuthMode, ResolvedProviderDefinition } from "@appstrate/core/validation";

export type { AuthMode };

/** Provider definition used by the connect package — extends core's resolved type with runtime fields. */
export type ProviderDefinition = ResolvedProviderDefinition & {
  /** Whether this provider has a PROVIDER.md companion file. */
  hasProviderDoc?: boolean;
};

export interface ConnectionRecord {
  id: string;
  profileId: string;
  providerId: string;
  orgId: string;
  credentialsEncrypted: string;
  scopesGranted: string[];
  expiresAt: string | null;
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
