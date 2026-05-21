// SPDX-License-Identifier: Apache-2.0

/**
 * Shared sidecar configuration types.
 *
 * Defined in @appstrate/core so that both the backend orchestrator
 * (apps/api) and the sidecar runtime (runtime-pi/sidecar) reference
 * a single source of truth for the wire-level shape they exchange
 * via environment variables at container start.
 */

/**
 * Sidecar runtime configuration. The sidecar process reads this from its
 * own environment at boot and uses it for the lifetime of the run. The
 * platform sends every field as an env var when spawning the container.
 */
export interface SidecarConfig {
  runToken: string;
  platformApiUrl: string;
  proxyUrl?: string;
  llm?: LlmProxyConfig;
  /**
   * Upstream model's total context window (tokens). When set, the sidecar's
   * {@link TokenBudget} adds a pre-flight guard: an `api_call` whose
   * inline emission would push cumulative tool-output tokens past
   * `modelContextWindow - modelMaxTokens` (reserve for the response) spills
   * to the blob store instead — preventing a parallel batch of large
   * tool_results from blowing past the upstream model's hard limit before
   * Pi SDK's turn-boundary compaction has a chance to fire. See issue #464.
   */
  modelContextWindow?: number;
  /**
   * Reserve (tokens) the upstream model keeps for its response. Defaults
   * to a conservative fraction of {@link modelContextWindow} when unset.
   * Sourced from the resolved model's `maxTokens` — same value the runner
   * passes to Pi SDK's compaction settings.
   */
  modelMaxTokens?: number;
}

/**
 * Platform → orchestrator spawn-boundary spec. Strict subset of
 * {@link SidecarConfig}: `platformApiUrl` is intentionally absent because
 * each orchestrator resolves it from its own context (Docker network
 * detection for the docker adapter, loopback for the process adapter)
 * right before spawning the container — see
 * `ContainerOrchestrator.resolvePlatformApiUrl`. Letting callers supply
 * a URL here would duplicate that resolution and let the two answers
 * drift apart.
 */
export interface SidecarLaunchSpec {
  runToken: string;
  proxyUrl?: string;
  llm?: LlmProxyConfig;
  /** See {@link SidecarConfig.modelContextWindow}. */
  modelContextWindow?: number;
  /** See {@link SidecarConfig.modelMaxTokens}. */
  modelMaxTokens?: number;
  /**
   * Integrations to bootstrap inside the sidecar (Phase 1.4). Each entry
   * declares an `type: integration` AFPS package the agent depends on —
   * the sidecar extracts the bundle, spawns the integration's MCP
   * server, and multiplexes its tools onto the agent-facing `/mcp`
   * surface. Empty / omitted = no integrations.
   *
   * Serialised by the orchestrator as the
   * `INTEGRATIONS_TO_SPAWN_JSON` env var read by
   * `runtime-pi/sidecar/server.ts`.
   */
  integrations?: ReadonlyArray<IntegrationSpawnSpec>;
}

/**
 * Per-integration spec consumed by the sidecar. The platform launcher
 * resolves the chain `agent.dependencies.integrations[id] →
 * applicationPackages → integration_connections` and emits one entry
 * per installed-and-connected integration.
 *
 * Bundle bytes are NOT inlined — they would blow past the Linux env
 * size limit (~1 MB) on real-world integrations (the Gmail MCP server
 * + its npm deps is ~5 MB). The sidecar fetches them at boot from
 * `GET /internal/integration-bundle/:scope/:name` using the same
 * Bearer run-token as the credentials surface.
 */
/**
 * Per-auth HTTP injection plan embedded in {@link IntegrationSpawnSpec}.
 * Extends the connect-side `HttpDeliveryPlan` shape with the two fields
 * the sidecar needs but the proxy planner doesn't: which manifest URIs
 * the auth is authorised for, and when the credential expires (for
 * proactive refresh scheduling).
 */
export interface HttpDeliveryAuthSpec {
  /** Auth type from the manifest (`oauth2` | `oauth1` | `api_key` | `basic` | `custom`). */
  authType: string;
  /** Header name to inject (e.g. `Authorization`). */
  headerName: string;
  /** Prefix prepended to the value (e.g. `"Bearer "`). May be empty. */
  headerPrefix: string;
  /** Rendered header value (already base64-encoded if the manifest declared it). */
  value: string;
  /** When `false` (default), the MITM proxy strips any caller-supplied header of the same name. */
  allowServerOverride: boolean;
  /**
   * URI patterns this auth is authorised for — glob-style strings copied verbatim
   * from `manifest.auths.{key}.authorizedUris`. The sidecar's planner uses these
   * to decide which auth (if any) applies to each upstream request.
   */
  authorizedUris: readonly string[];
  /**
   * Epoch milliseconds the credential expires at. `null` when expiry is unknown
   * (api_key, basic, custom) — sidecar refresh logic is skipped in that case.
   */
  expiresAtEpochMs: number | null;
}

export interface IntegrationSpawnSpec {
  /** Package id (e.g. `@appstrate/gmail-mcp`). */
  packageId: string;
  /** McpHost namespace — tool names are prefixed with `{namespace}__`. */
  namespace: string;
  /** Validated `type: integration` manifest (server, transport, auths). */
  manifest: {
    name: string;
    version: string;
    /**
     * MCP server to spawn/connect. Optional: a pure-proxy integration
     * (`apiCall` with no `server` — the migrated-provider shape) has no
     * MCP server. The sidecar skips spawn entirely for such specs and
     * only exposes the generic `api_call` tool.
     */
    server?: {
      type: string;
      entryPoint?: string;
      /**
       * Phase 7 — remote MCP endpoint URL. Required when `server.type` is
       * `"http"`. The sidecar opens a Streamable HTTP MCP client against
       * this URL instead of spawning a runner. Mutually exclusive with
       * `entryPoint` (enforced by `integrationManifestSchema`).
       */
      url?: string;
    };
    transport?: { type: string };
  };
  /**
   * Generic credential-injecting HTTP tool (provider→integration
   * unification). Set when the manifest declares `apiCall` AND the agent
   * selected the `api_call` tool. The sidecar registers a
   * `{namespace}__api_call` tool that proxies an arbitrary upstream
   * request bounded by {@link authorizedUris}, injecting the resolved
   * auth's credential header via the same machinery as `delivery.http`.
   *
   * Credentials are NOT inlined here — the sidecar reads them from the
   * `/internal/integration-credentials` surface (same as MITM / remote
   * HTTP) so a leaked env var can't surface a live token.
   */
  apiCall?: {
    /** Which declared auth supplies credentials + authorizedUris. */
    authKey: string;
    /** URI allowlist (verbatim from `auths.{authKey}.authorizedUris`). */
    authorizedUris: readonly string[];
    /**
     * Skip the `authorizedUris` allowlist (SSRF blocklist still applies).
     * From `auths.{authKey}.allowAllUris` — for user-supplied base URLs.
     */
    allowAllUris?: boolean;
    /** Resumable-upload protocols the tool advertises (may be empty). */
    uploadProtocols?: readonly string[];
  };
  /**
   * Env vars to inject on the spawned subprocess. Resolved from
   * `manifest.auths.{key}.delivery.env` by the platform — values are
   * the live OAuth access_token / API key. Sensitive: never logged.
   */
  spawnEnv: Record<string, string>;
  /**
   * Phase 1.5 — per-auth `delivery.http` metadata. The sidecar starts a
   * per-integration MITM HTTPS proxy and uses these plans to inject
   * `headerName: headerPrefix + value` on every upstream request whose
   * URL matches an `authorizedUris` pattern of the matching auth.
   *
   * Sensitive (`value` carries the live OAuth access_token / API key);
   * never logged. Omitted when the integration has no `delivery.http`
   * auths — those integrations stay on the env-delivery-only path.
   */
  httpDeliveryAuths?: Record<string, HttpDeliveryAuthSpec>;
  /**
   * Niveau 2 Phase 3 — agent-declared MCP tool allowlist. The sidecar's
   * `McpHost` filters `tools/list` to only expose these tools to the
   * agent and rejects `tools/call` for any tool outside the set
   * (returning a structured "tool_not_authorized" error without ever
   * forwarding to the integration).
   *
   * Always an array (never undefined): the platform builds it from
   * `manifest.integrations[id].tools` and defaults to `[]` when the
   * agent author didn't pick any tool — least privilege by default,
   * the integration still spawns (so env-delivery / MITM credentials
   * remain functional for side-channel use) but exposes nothing to the
   * agent's LLM.
   */
  toolAllowlist: readonly string[];
  /**
   * Niveau 2 Phase 4 — URL-pattern envelope enforced by the sidecar
   * MITM proxy. Defence-in-depth on top of `toolAllowlist`: even if a
   * registered tool somehow issues a request outside its declared URL
   * surface (compromised integration code, prompt-injection coercing
   * the integration to talk to an unrelated endpoint), the MITM refuses
   * the request before the credential is injected upstream.
   *
   * Resolved by the platform as `⋃ manifest.tools[t].urlPatterns` for
   * every `t` in {@link toolAllowlist}. Only emitted when EVERY tool in
   * the allowlist declares non-empty `urlPatterns` — a single tool
   * without patterns means we can't safely enforce (we'd block legit
   * traffic), so the field is left `undefined` (no extra enforcement).
   *
   * `undefined` preserves the historical behaviour where only the
   * per-auth `authorizedUris` allowlist gates outbound traffic. The
   * envelope is narrower than `authorizedUris` and is checked first;
   * `authorizedUris` still applies (via {@link httpDeliveryAuths}) for
   * deciding which credential to inject.
   *
   * `methods` (when present) constrains the HTTP verb; omitted means
   * any method matches.
   */
  toolUrlEnvelope?: ReadonlyArray<{
    pattern: string;
    methods?: readonly string[];
  }>;
}

/**
 * Discriminated union covering the two LLM auth modes the sidecar can serve:
 *
 *   - `api_key`: the agent SDK builds the auth header with a placeholder and
 *     the sidecar swaps the placeholder for the real key.
 *   - `oauth`: the sidecar fetches a fresh access token from the platform
 *     (`GET /internal/oauth-token/:connectionId`) and injects it as the
 *     bearer + the per-provider identity headers + applies the declarative
 *     body transforms read from `wireFormat` (system-prepend, force-stream,
 *     force-store).
 */
export type LlmProxyConfig = LlmProxyApiKeyConfig | LlmProxyOauthConfig;

/**
 * Canonical wire-format identifier for every LLM model provider Appstrate
 * proxies to. Lives here (in core) so that the sidecar runtime, the
 * platform's model-provider registry, and the OAuth token cache all reference
 * a single source of truth — drift between the three previously caused 401s
 * to surface as "unknown apiShape" rather than a real auth failure.
 */
export type ModelApiShape =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "mistral-conversations"
  | "google-generative-ai"
  | "google-vertex"
  | "azure-openai-responses"
  | "bedrock-converse-stream";

export interface LlmProxyApiKeyConfig {
  authMode: "api_key";
  /** Upstream provider base URL the sidecar forwards to. */
  baseUrl: string;
  apiKey: string;
  placeholder: string;
}

export interface LlmProxyOauthConfig {
  authMode: "oauth";
  /** Fallback base URL — the sidecar prefers `baseUrl` returned by the platform's token endpoint. */
  baseUrl: string;
  /** ID of the `model_provider_credentials` row backing this OAuth connection. */
  credentialId: string;
  /**
   * Declarative wire-format contract contributed by the provider module
   * (`ModelProviderDefinition.oauthWireFormat`). Drives identity-header
   * injection, body transforms (system prepend, `forceStream`, `forceStore`),
   * URL path rewriting, and adaptive header retries without the sidecar
   * needing to know any provider name. When absent, no identity headers or
   * transforms apply.
   */
  wireFormat?: OAuthWireFormat;
}

/**
 * Declarative wire-format quirks an OAuth model provider needs the sidecar
 * to apply on its behalf. Lives in {@link LlmProxyOauthConfig} (carried at
 * boot via env), so the sidecar runtime stays provider-agnostic — there is
 * no provider-name switch anywhere; every behavior is data-driven from this
 * struct.
 *
 * All fields optional. An empty `OAuthWireFormat` is equivalent to "pass
 * the agent's request through with just the bearer attached."
 */
export interface OAuthWireFormat {
  /**
   * Static headers injected on every OAuth-authenticated upstream call.
   * Lower-cased keys recommended; the sidecar forwards verbatim. Used for
   * provider fingerprinting (a fixed client-identity header the upstream
   * expects to see on subscription-bearing calls).
   */
  identityHeaders?: Record<string, string>;
  /**
   * Header name to echo the resolved `accountId` as (when the token endpoint
   * surfaced one). Skipped when the cached token carries no `accountId`.
   */
  accountIdHeader?: string;
  /**
   * Anthropic-style system-prompt prelude prepended to outbound JSON
   * bodies. Applied only when the request body is a JSON object with a
   * `system` field — otherwise pass-through.
   */
  systemPrepend?: { type: "text"; text: string };
  /** Force `stream: true` on outbound JSON bodies (required by some subscription-flavoured providers). */
  forceStream?: boolean;
  /** Force `store: false` on outbound JSON bodies (required by some subscription-flavoured providers). */
  forceStore?: boolean;
  /** Path rewriting applied at the proxy boundary. */
  rewriteUrlPath?: { from: string; to: string };
  /**
   * Single adaptive retry policy: when an upstream returns `status` and
   * the response body matches any of `bodyPatterns` (case-insensitive
   * regex), strip `removeToken` from the comma-separated header named
   * `headerName` and replay the request once. Used by Anthropic to fall
   * back when the long-context beta isn't available on the account.
   */
  adaptiveRetry?: OAuthAdaptiveRetryPolicy;
}

/** See {@link OAuthWireFormat.adaptiveRetry}. */
export interface OAuthAdaptiveRetryPolicy {
  /** HTTP status code triggering the retry (typically 400). */
  status: number;
  /** Body-text patterns (case-insensitive regex strings). Any match triggers retry. */
  bodyPatterns: readonly string[];
  /** Header name to mutate (case-insensitive lookup). */
  headerName: string;
  /** Comma-separated token to remove from the header value before retry. */
  removeToken: string;
}

/**
 * Wire-format response from the platform's `GET /internal/oauth-token/:credentialId`
 * (and `POST .../refresh`) endpoint. Carries only the fields that change per
 * refresh — provider invariants (baseUrl, providerId, wireFormat) live in
 * {@link LlmProxyOauthConfig}, which the sidecar already received at boot.
 */
export interface OAuthTokenResponse {
  accessToken: string;
  /** Epoch milliseconds. `null` when expiry is unknown — sidecar treats this as "always refresh". */
  expiresAt: number | null;
  /**
   * Abstract account/tenant identifier surfaced by the provider's
   * `extractTokenIdentity` hook. Echoed by the sidecar as the header
   * named by {@link OAuthWireFormat.accountIdHeader} (when both are set).
   */
  accountId?: string;
}

/**
 * Refresh lead time (epoch-ms): proactively refresh an OAuth access token when
 * its remaining lifetime drops below this threshold. Both the platform's
 * `resolveOAuthTokenForSidecar` and the sidecar's `OAuthTokenCache` honor this
 * value — keeping them in sync is critical: if the sidecar caches a token as
 * "fresh" while the platform considers it stale, the agent path 401s exactly
 * when the token expires.
 */
export const OAUTH_REFRESH_LEAD_MS = 5 * 60_000;
