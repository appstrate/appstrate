// SPDX-License-Identifier: Apache-2.0

// Types
export type { Actor, OAuthStateRecord, OAuthStateStore, TokenEndpointAuthMethod } from "./types.ts";
// Encryption
export {
  encrypt,
  decrypt,
  encryptCredentials,
  decryptCredentials,
  encryptCredentialEnvelope,
} from "./encryption.ts";

// OAuth2 token-exchange error type (shared by token-exchange.ts + integration OAuth)
export { OAuthCallbackError } from "./oauth.ts";

// SSRF-guarded OAuth egress (token exchange/refresh, issuer discovery, userinfo)
// with an opt-in internal-IdP allowlist. Shared by connect's token helpers and
// apps/api's OAuth2 strategy so every secret-bearing OAuth request is fail-closed.
export { oauthEgressFetch, isAllowedInternalIdpHost, SsrfBlockedError } from "./oauth-egress.ts";

// Token refresh
export { RefreshError, performRefreshTokenExchange } from "./token-refresh.ts";
export type { RefreshExchangeResult } from "./token-refresh.ts";

// The one token-endpoint symbol that crosses the package boundary: apps/api's
// integration refresh classifies on it. `parseTokenResponse`, the request
// builders and the error classifier stay internal — `token-exchange.ts` /
// `token-refresh.ts` are the only callers and they import the concrete module.
export { ClientAuthInvariantError } from "./token-utils.ts";

// Credential-proxy primitives, in the shape the /api/credential-proxy/proxy
// route's service layer consumes them. The in-container sidecar runs the same
// primitives but imports `@appstrate/connect/proxy-primitives` directly, so
// its binary does not pull this barrel's credentials module (transitively
// `@appstrate/db`) — see `runtime-pi/sidecar/helpers.ts`. Only what a barrel
// consumer actually imports is re-exported here; the sidecar-only half
// (`HOP_BY_HOP_HEADERS`, `filterHeaders`, `applyInjectedCredentialHeader`,
// `normalizeAuthSchemeTemplates`) and the in-package-only
// `buildInjectedCredentialHeader` are reached through the subpath.
export {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
  applyInjectedCredentialHeaderToHeaders,
  normalizeAuthSchemeTemplate,
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

// CA cert planner for the HTTPS credential proxy (§5.4.1). Its types are
// reached through `@appstrate/connect/proxy-ca-planner` (the sidecar's MITM
// listener names `CaBundle`); nothing imports them from this barrel.
export { planCaBundle } from "./proxy-ca-planner.ts";

// Shared OAuth token-refresh request shape (consumed by integration-side refresh too).
export type { RefreshContext } from "./token-refresh.ts";

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
export {
  resolveOAuthEndpoints,
  buildDiscoveryProbes,
  discoveryIssuerMatches,
} from "./oauth-discovery.ts";

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
// Only the orchestrating entry point crosses the boundary; the probe builder
// and the WWW-Authenticate parser are its internals.
// Only the two orchestrating entry points cross the boundary; callers build
// the argument inline and read the result via inference, so neither module's
// input/output types are re-exported here.
export { discoverProtectedResourceMetadata } from "./mcp-oauth-discovery.ts";
export { registerDynamicClient, DynamicClientRegistrationError } from "./dcr.ts";
