// SPDX-License-Identifier: Apache-2.0

// Types
export type { Actor, OAuthStateRecord, OAuthStateStore } from "./types.ts";
// Encryption
export {
  encrypt,
  decrypt,
  encryptCredentials,
  decryptCredentials,
  encryptCredentialEnvelope,
} from "./encryption.ts";
export type { CredentialEnvelope } from "./encryption.ts";

// OAuth2 token-exchange error type (shared by token-exchange.ts + integration OAuth)
export { OAuthCallbackError } from "./oauth.ts";

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
export type { ProxyCredentialsPayload } from "./proxy-primitives.ts";

// ─── AFPS integration manifest ─────────────────────────────────────────
// Multi-auth credential resolver + delivery planners.
export { buildProxyCredentialsPayload } from "./integration-credentials.ts";
// Credential-envelope decryptors — split out so they (and `encryption.ts` →
// `@appstrate/env`) stay off the sidecar's import graph. Platform-only.
export {
  decryptCredentialsToStringMap,
  decryptCredentialInputsToStringMap,
} from "./credential-decrypt.ts";
export type {
  ResolvedAuthCredentials,
  IntegrationCredentialsPayload,
  HttpDeliveryPlan,
  IntegrationCredentialsWire,
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
export type { MitmRequestContext } from "./integration-mitm-planner.ts";

// Connect-session tokens — short-lived HMAC capability tokens that gate the
// unified hosted-connect-portal flow (issue #769). Stateless mint/verify;
// the secret (`CONNECT_SESSION_SECRET`) and single-use `jti` enforcement are
// the caller's responsibility.
export { mintConnectSession, verifyConnectSession } from "./connect-session-token.ts";
export type { ConnectSessionClaims } from "./connect-session-token.ts";

// AFPS `delivery.http` resolver (snake_case, `{$credential.<field>}`
// value templates).
export { resolveAfpsHttpDelivery } from "./afps-delivery.ts";
export type { AfpsHttpDelivery } from "./afps-delivery.ts";

// Discovery-first OAuth endpoint resolution (RFC 8414 / OIDC). Used by the
// integration OAuth initiate path when an auth declares an `issuer`.
export { resolveOAuthEndpoints } from "./oauth-discovery.ts";
export type { OAuthEndpointResolution, ResolveOAuthEndpointsInput } from "./oauth-discovery.ts";

// OAuth2 user-facing connect flow for integration auths (used by the
// marketplace UI; parameterised by manifest endpoints + admin-registered
// client credentials).
export { initiateIntegrationOAuth, handleIntegrationOAuthCallback } from "./integration-oauth.ts";
// Only the callback-result type crosses the package boundary (apps/api's
// integrations route + connect strategy). The initiate-side input/result
// shapes stay internal — callers build the argument inline and read the
// result via inference.
export type { IntegrationOAuthCallbackResult } from "./integration-oauth.ts";

// MCP-spec auto-DCR primitives (RFC 9728 protected-resource discovery + RFC 7591
// dynamic client registration). The apps/api orchestrator chains these to
// self-register an OAuth client when an integration opts into dynamic
// registration and no client is pre-registered.
export {
  discoverProtectedResourceMetadata,
  buildProtectedResourceProbes,
  parseResourceMetadataChallenge,
} from "./mcp-oauth-discovery.ts";
export type {
  ProtectedResourceMetadata,
  DiscoverProtectedResourceInput,
} from "./mcp-oauth-discovery.ts";
export { registerDynamicClient, DynamicClientRegistrationError } from "./dcr.ts";
export type { RegisterDynamicClientInput, DynamicClientRegistration } from "./dcr.ts";
