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

// ─── AFPS integration runtime (Phase 1.2a) ─────────────────────────────
// Pure spawn-side helpers — server resolver, command builder, proxy env.
export {
  IntegrationRuntimeError,
  buildProxyEnvInjection,
  buildSpawnCommand,
  resolveIntegrationServer,
  validateIntegrationServer,
  validateRuntimeCompatibility,
} from "./integration-runtime.ts";
export type {
  IntegrationRuntimeErrorCode,
  ProxyEnvInjectionInput,
  ResolvedDockerSpawnTarget,
  ResolvedLocalSpawnTarget,
  ResolvedSpawnTarget,
  SpawnCommandPlan,
} from "./integration-runtime.ts";

// Restart-with-backoff supervisor (proposal §5.4.2).
export { superviseProcess } from "./restart-supervisor.ts";
export type {
  ChildExit,
  ChildHandle,
  SupervisedProcess,
  SupervisorEvent,
  SupervisorOptions,
  SupervisorOutcome,
} from "./restart-supervisor.ts";

// Top-level spawn orchestrator + SIGHUP cred-refresh signal dispatch.
export { SpawnFailureError, spawnIntegrations } from "./integration-orchestrator.ts";
export type {
  IntegrationOrchestrator,
  IntegrationOrchestratorEvent,
  IntegrationSpawnRequest,
  RunningIntegration,
  SignalDispatcher,
  SpawnIntegrationsOptions,
} from "./integration-orchestrator.ts";

// toolsDynamic runtime re-discovery + drift detection (§5.4.6).
export {
  DEFAULT_TOOLS_DISCOVERY_TTL_MS,
  buildConnectedAuthsKey,
  clearToolsDiscoveryCache,
  diffToolsAgainstLock,
  discoverToolsForUser,
  invalidateToolsForIntegration,
  invalidateToolsForUser,
  toolsDiscoveryCacheSize,
} from "./tools-discovery.ts";
export type {
  DiscoveredTools,
  Tool,
  ToolsDiff,
  ToolsDiscoveryOptions,
  ToolsDiscoveryRequest,
} from "./tools-discovery.ts";

// CA cert planner for the HTTPS credential proxy (§5.4.1).
export { bundleToFsWrites, makeGeneratorIdentity, planCaBundle } from "./proxy-ca-planner.ts";
export type {
  CaBundle,
  CaGenerationOutput,
  CaGenerationRequest,
  CertGenerator,
  FsWriteEntry,
  PlanCaBundleOptions,
} from "./proxy-ca-planner.ts";

// Pure MITM action planner — drives the per-integration HTTPS proxy
// listener (§4.1.4 strip/inject/retry logic).
export { pickAuthForUrl, planMitmAction } from "./integration-mitm-planner.ts";
export type { MitmAction, MitmRequestContext } from "./integration-mitm-planner.ts";

// Phase 1.3 — OAuth2 user-facing connect flow for integration auths
// (used by the marketplace UI; mirrors `./oauth.ts` but parameterised
// by manifest endpoints + admin-registered client credentials).
export {
  initiateIntegrationOAuth,
  handleIntegrationOAuthCallback,
  integrationProviderIdSentinel,
} from "./integration-oauth.ts";
export type {
  InitiateIntegrationOAuthInput,
  InitiateIntegrationOAuthResult,
  IntegrationOAuthCallbackResult,
} from "./integration-oauth.ts";

// ─── AFPS integration runtime (Phase 1.2b) ─────────────────────────────
// RFC 7591 Dynamic Client Registration.
export { DcrError, registerClient } from "./dynamic-client-registration.ts";
export type {
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  DcrErrorCode,
  DcrFetchFn,
  RegisterClientOptions,
} from "./dynamic-client-registration.ts";

// MCP HTTP transport OAuth 2.1 wrapper.
export {
  AuthLoopExceededError,
  StepUpFailedError,
  buildAuthorizationUrl,
  executeWithBearer,
  parseWwwAuthenticateChallenge,
} from "./mcp-http-auth.ts";
export type {
  BearerCredential,
  BuildAuthorizationUrlInput,
  ExecuteWithBearerOptions,
  ExecuteWithBearerResult,
  WwwAuthenticateChallenge,
} from "./mcp-http-auth.ts";
