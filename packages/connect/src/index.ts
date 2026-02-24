// Types
export type {
  AuthMode,
  ProviderDefinition,
  ProviderSnapshot,
  ConnectionRecord,
  DecryptedCredentials,
  OAuthStateRecord,
  ScopeValidationResult,
} from "./types.ts";
// Encryption
export { encrypt, decrypt, encryptCredentials, decryptCredentials } from "./encryption.ts";

// Scopes
export { validateScopes } from "./scopes.ts";

// Registry
export {
  initBuiltInProviders,
  getProvider,
  getProviderOrThrow,
  getProviderOAuthCredentials,
  getProviderOAuthCredentialsOrThrow,
  listProviders,
  getProviderAuthMode,
  getDefaultAuthorizedUris,
  getCredentialFieldName,
  getBuiltInProviders,
  isBuiltInProvider,
} from "./registry.ts";
export type { Db } from "./registry.ts";

// OAuth2
export { initiateOAuth, handleOAuthCallback } from "./oauth.ts";
export type { InitiateOAuthResult, OAuthCallbackResult } from "./oauth.ts";

// Token Refresh
export { refreshIfNeeded } from "./token-refresh.ts";

// Credentials
export {
  getConnection,
  listConnections,
  getCredentials,
  resolveCredentialsForProxy,
  saveConnection,
  deleteConnection,
} from "./credentials.ts";
