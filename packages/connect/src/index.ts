// Types
export type {
  AuthMode,
  ProviderDefinition,
  ProviderSnapshot,
  ConnectionRecord,
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
  getProviderOAuthCredentialsOrThrow,
  listProviders,
  getProviderAuthMode,
  getDefaultAuthorizedUris,
  getCredentialFieldName,
  getBuiltInProviders,
  isBuiltInProvider,
} from "./registry.ts";

// OAuth2
export { initiateOAuth, handleOAuthCallback } from "./oauth.ts";
export type { InitiateOAuthResult, OAuthCallbackResult } from "./oauth.ts";

// OAuth1
export { initiateOAuth1, handleOAuth1Callback } from "./oauth1.ts";
export type { OAuth1CallbackResult } from "./oauth1.ts";

// Credentials
export {
  getConnection,
  listConnections,
  getCredentials,
  resolveCredentialsForProxy,
  saveConnection,
  deleteConnection,
  deleteConnectionById,
} from "./credentials.ts";
