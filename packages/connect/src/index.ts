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
export { RefreshError, performRefreshTokenExchange } from "./token-refresh.ts";
export type { RefreshExchangeResult } from "./token-refresh.ts";

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
// Multi-auth credential resolver + delivery planners.
export {
  ALIAS_MAP,
  decryptCredentialsToStringMap,
  readCredentialField,
  resolveHttpDelivery,
} from "./integration-credentials.ts";
export type {
  ResolvedAuthCredentials,
  IntegrationCredentialsPayload,
  HttpDeliveryPlan,
} from "./integration-credentials.ts";

// CA cert planner for the HTTPS credential proxy (§5.4.1).
export { planCaBundle } from "./proxy-ca-planner.ts";
export type {
  CaBundle,
  CaGenerationOutput,
  CaGenerationRequest,
  CertGenerator,
  PlanCaBundleOptions,
} from "./proxy-ca-planner.ts";

// Shared OAuth token-refresh request shape (consumed by integration-side refresh too).
export type { RefreshContext } from "./token-refresh.ts";

// Pure MITM action planner — drives the per-integration HTTPS proxy
// listener (§4.1.4 strip/inject/retry logic).
export { planMitmAction } from "./integration-mitm-planner.ts";
export type { MitmAction, MitmRequestContext } from "./integration-mitm-planner.ts";

// Phase 1.3 — OAuth2 user-facing connect flow for integration auths
// (used by the marketplace UI; mirrors `./oauth.ts` but parameterised
// by manifest endpoints + admin-registered client credentials).
export { initiateIntegrationOAuth, handleIntegrationOAuthCallback } from "./integration-oauth.ts";
export type {
  InitiateIntegrationOAuthInput,
  InitiateIntegrationOAuthResult,
  IntegrationOAuthCallbackResult,
} from "./integration-oauth.ts";
