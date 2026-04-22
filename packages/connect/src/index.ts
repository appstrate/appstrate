// SPDX-License-Identifier: Apache-2.0

// Types
export type {
  Actor,
  AuthMode,
  ProviderDefinition,
  ConnectionRecord,
  ScopeValidationResult,
  OAuthStateRecord,
  OAuthStateStore,
} from "./types.ts";
// Encryption
export { encrypt, decrypt, encryptCredentials, decryptCredentials } from "./encryption.ts";

// Scopes
export { validateScopes } from "./scopes.ts";

// Registry
export {
  getProvider,
  getProviderOrThrow,
  getProviderOAuthCredentialsOrThrow,
  getProviderOAuth1CredentialsOrThrow,
  listProviders,
  getProviderAuthMode,
  getDefaultAuthorizedUris,
  getCredentialFieldName,
  isProviderEnabled,
} from "./registry.ts";

// OAuth2
export { initiateOAuth, handleOAuthCallback } from "./oauth.ts";
export type { InitiateOAuthResult, OAuthCallbackResult } from "./oauth.ts";

// OAuth1
export { initiateOAuth1, handleOAuth1Callback } from "./oauth1.ts";
export type { OAuth1CallbackResult } from "./oauth1.ts";

// Token refresh
export { RefreshError } from "./token-refresh.ts";

// Credentials
export {
  getConnection,
  listConnections,
  getCredentials,
  resolveCredentialsForProxy,
  forceRefreshCredentials,
  saveConnection,
  deleteConnection,
  deleteConnectionById,
  getProviderCredentialId,
  listProviderCredentialIds,
  listConfiguredProviderIds,
} from "./credentials.ts";

// Credential-proxy primitives (shared between the /api/credential-proxy/proxy
// route and the in-container sidecar to prevent silent drift).
export {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
  HOP_BY_HOP_HEADERS,
  filterHeaders,
} from "./proxy-primitives.ts";
