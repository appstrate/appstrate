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
export { initiateOAuth, handleOAuthCallback, OAuthCallbackError } from "./oauth.ts";
export type { InitiateOAuthResult, OAuthCallbackResult } from "./oauth.ts";

// OAuth1
export { initiateOAuth1, handleOAuth1Callback } from "./oauth1.ts";
export type { OAuth1CallbackResult } from "./oauth1.ts";

// Token refresh
export { RefreshError } from "./token-refresh.ts";

// Token error classification + low-level OAuth token endpoint helpers
// (shared by callback + refresh + custom OAuth flows like model providers).
export {
  parseTokenErrorResponse,
  parseTokenResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "./token-utils.ts";
export type {
  TokenErrorKind,
  TokenErrorClassification,
  ParsedTokenResponse,
} from "./token-utils.ts";

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
export type { ProxyCredentialsPayload } from "./credentials.ts";

// Credential-proxy primitives (shared between the /api/credential-proxy/proxy
// route and the in-container sidecar to prevent silent drift).
export {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
  HOP_BY_HOP_HEADERS,
  filterHeaders,
  buildInjectedCredentialHeader,
  applyInjectedCredentialHeader,
  applyInjectedCredentialHeaderToHeaders,
  normalizeAuthScheme,
  normalizeAuthSchemeOnHeaders,
} from "./proxy-primitives.ts";
// `ProxyCredentialsPayload` is re-exported from `./credentials.ts` above —
// it physically lives in `proxy-primitives.ts` so the sidecar can consume
// it without pulling @appstrate/db. Single type, shared by both paths.

// ─── AFPS integration manifest (Phase 1.1) ─────────────────────────────
// RFC 8707 audience binding (no DB / network).
export {
  appendResourceToTokenBody,
  buildAuthorizeResourceQuery,
  categorizeAudienceResponse,
} from "./audience-binding.ts";
export type {
  AudienceInput,
  AudienceResponseCategory,
  OAuthErrorResponse,
} from "./audience-binding.ts";

// RFC 9728 / RFC 8414 discovery cascade.
export {
  discoverEndpoints,
  selectAuthorizationServer,
  buildAsMetadataUrl,
  clearDiscoveryCache,
  DiscoveryError,
  DEFAULT_DISCOVERY_TTL_MS,
} from "./oauth-discovery.ts";
export type {
  ResolvedAuthorizationEndpoints,
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
  FetchJsonFn,
  ClockFn,
  DiscoverEndpointsOptions,
  DiscoveryErrorCode,
} from "./oauth-discovery.ts";

// Multi-auth credential resolver + delivery planners.
export {
  ALIAS_MAP,
  resolveIntegrationCredentials,
  readCredentialField,
  resolveHttpDelivery,
  resolveEnvDelivery,
  resolveFilesDelivery,
  routeRequestToAuth,
} from "./integration-credentials.ts";
export type {
  ResolvedAuthCredentials,
  IntegrationCredentialsPayload,
  AuthCredentialBundle,
  HttpDeliveryPlan,
  EnvDeliveryEntry,
  FileDeliveryEntry,
} from "./integration-credentials.ts";
