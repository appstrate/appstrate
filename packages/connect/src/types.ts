import type { AuthMode, ResolvedProviderDefinition } from "@appstrate/core/validation";

export type { AuthMode };

/** Provider definition used by the connect package — alias for core's resolved type. */
export type ProviderDefinition = ResolvedProviderDefinition;

export interface ConnectionRecord {
  id: string;
  profileId: string;
  providerId: string;
  credentialsEncrypted: string;
  scopesGranted: string[];
  expiresAt: string | null;
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
