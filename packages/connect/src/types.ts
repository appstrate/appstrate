import type { JSONSchemaObject, AvailableScope, AuthMode } from "@appstrate/shared-types";
import type { ProviderDefinitionFields } from "@appstrate/core/validation";

export type { AuthMode };

/** Strip the `[x: string]: unknown` index signature that z.looseObject() adds. */
type KnownKeys<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** Fields overridden with stricter types for consumer usage. */
type StricterFields =
  | "authMode"
  | "authorizationParams"
  | "tokenParams"
  | "tokenAuthMethod"
  | "credentialSchema"
  | "availableScopes";

/**
 * Full provider definition including identity + meta fields.
 * Technical fields derive from core's ProviderDefinitionFields.
 */
export interface ProviderDefinition
  extends Omit<KnownKeys<ProviderDefinitionFields>, StricterFields> {
  id: string;
  displayName: string;
  authMode: AuthMode;
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic";
  credentialSchema?: JSONSchemaObject;
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
