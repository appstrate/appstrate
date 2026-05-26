// SPDX-License-Identifier: Apache-2.0

/**
 * Shared sidecar configuration types.
 *
 * Defined in @appstrate/core so that both the backend orchestrator
 * (apps/api) and the sidecar runtime (runtime-pi/sidecar) reference
 * a single source of truth for the wire-level shape they exchange
 * via environment variables at container start.
 */

import type { IntegrationManifest } from "./integration.ts";

/**
 * Manifest `auths.{key}.delivery.http` block — the header-render config the
 * sidecar's connect-login primitive feeds to `resolveHttpDelivery`. Reused
 * verbatim from the integration manifest type so the spawn-side and
 * sidecar-side shapes can never drift.
 */
export type ManifestDeliveryHttp = NonNullable<
  NonNullable<IntegrationManifest["auths"]>[string]["delivery"]["http"]
>;

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
  /**
   * Platform runtime tools the agent selected (`manifest.runtime_tools`):
   * any of `output` / `log` / `note` / `pin` / `report`. The sidecar hosts
   * the selected ones as in-process MCP tools on the agent-facing `/mcp`
   * surface (`@appstrate/core/runtime-tool-defs`), so they are unified with
   * the integration tools instead of being Pi-SDK-specific extensions.
   * Empty / omitted = none. Serialised as the `RUNTIME_TOOLS_JSON` env var.
   */
  runtimeTools?: readonly string[];
  /**
   * Output JSON Schema (`manifest.output.schema`). Forwarded so the
   * sidecar's `output` runtime tool exposes it as the `data` argument
   * schema (constrained decoding) and validates against it at call time.
   * Serialised as the `OUTPUT_SCHEMA` env var. Omitted when the agent
   * declares no output schema.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * P4 — connect-run mode (`runAt: "link"`). When set, the sidecar runs in
   * "connect mode": it boots the SINGLE integration carried in `integrations`,
   * runs its `login` MCP tool exactly once (`runConnectOnce`), emits the
   * captured credential bundle on a sentinel stdout line, and exits — the
   * agent-facing `/mcp` server is never started.
   *
   * Serialised by the orchestrator as the `CONNECT_LOGIN_JSON` env var read by
   * `runtime-pi/sidecar/server.ts`. The value is the same single
   * {@link IntegrationSpawnSpec} (with its `connectLogin` block) that
   * `integrations` carries; it is sensitive (the `connectLogin.inputs` plane
   * is the decrypted login secret) and never logged.
   */
  connectLoginSpec?: IntegrationSpawnSpec;
}

/**
 * Per-integration spec consumed by the sidecar. The platform launcher
 * resolves the chain `agent.dependencies.integrations[id] →
 * applicationPackages → integration_connections` and emits one entry
 * per installed-and-connected integration.
 *
 * Bundle bytes are NOT inlined — they would blow past the Linux env
 * size limit (~1 MB) on real-world servers (the Gmail MCP server
 * + its npm deps is ~5 MB). For local-source integrations the sidecar
 * fetches the referenced mcp-server package's bundle at boot from
 * `GET /internal/mcp-server-bundle/:scope/:name` using the same
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
  /** Auth type from the manifest (`oauth2` | `api_key` | `basic` | `custom`). */
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
   * from `manifest.auths.{key}.authorized_uris`. The sidecar's planner uses these
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
  /** Integration package id (e.g. `@appstrate/gmail-mcp`). */
  integrationId: string;
  /** McpHost namespace — tool names are prefixed with `{namespace}__`. */
  namespace: string;
  /** Validated `type: integration` manifest (server, auths). */
  manifest: {
    name: string;
    version: string;
    /**
     * MCP server to spawn/connect. Optional on the spawn spec: the
     * resolver omits it for serverless integrations (`source.kind: "api"`,
     * no `server`), which expose only the generic `api_call` tool. The
     * sidecar skips spawn entirely for such specs.
     */
    server?: {
      type: string;
      entryPoint?: string;
      /**
       * AFPS 2.0 — the SEPARATE `mcp-server` package id this integration's
       * `source.kind: "local"` references (`source.server.name`). The sidecar
       * fetches THIS package's `.afps` bundle (the runnable server code) from
       * `GET /internal/mcp-server-bundle/:scope/:name`, NOT the integration's
       * own bundle. Set for local sources; omitted for remote (`http`) and
       * serverless (`api`) integrations.
       */
      serverPackageId?: string;
      /**
       * Phase 7 — remote MCP endpoint URL. Required when `server.type` is
       * `"http"`. The sidecar opens a Streamable HTTP MCP client against
       * this URL instead of spawning a runner. Mutually exclusive with
       * `entryPoint` (enforced by `integrationManifestSchema`).
       */
      url?: string;
    };
  };
  /**
   * Generic credential-injecting HTTP tool. Set when the manifest declares
   * `source.kind: "api"` AND the agent
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
    /** Which declared auth supplies credentials + authorized_uris. */
    authKey: string;
    /** URI allowlist (verbatim from `auths.{authKey}.authorized_uris`). */
    authorizedUris: readonly string[];
    /**
     * Skip the `authorized_uris` allowlist (SSRF blocklist still applies).
     * From `auths.{authKey}.allow_all_uris` — for user-supplied base URLs.
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
   * Resolved by the platform as `⋃ manifest.tools[t].url_patterns` for
   * every `t` in {@link toolAllowlist}. Only emitted when EVERY tool in
   * the allowlist declares non-empty `url_patterns` — a single tool
   * without patterns means we can't safely enforce (we'd block legit
   * traffic), so the field is left `undefined` (no extra enforcement).
   *
   * `undefined` preserves the historical behaviour where only the
   * per-auth `authorized_uris` allowlist gates outbound traffic. The
   * envelope is narrower than `authorized_uris` and is checked first;
   * `authorized_uris` still applies (via {@link httpDeliveryAuths}) for
   * deciding which credential to inject.
   *
   * `methods` (when present) constrains the HTTP verb; omitted means
   * any method matches.
   */
  toolUrlEnvelope?: ReadonlyArray<{
    pattern: string;
    methods?: readonly string[];
  }>;
  /**
   * connect.tool substrate — `runAt: "run-start"` acquisition (P2). When
   * set, the integration's session is NOT pre-resolved at spawn: only the
   * login secret (`inputs`) was stored at dashboard connect. The sidecar
   * mints the session at boot by calling the integration's `login` MCP tool
   * via `runConnectLogin`, substituting `inputs` proxy-side. After capture,
   * the integration's MITM source injects the session header for the rest
   * of the run.
   *
   * `inputs` is the decrypted login-secret plane — sidecar-only, same trust
   * level as {@link spawnEnv} (travels in `INTEGRATIONS_TO_SPAWN_JSON`).
   * Never logged. The login tool is excluded from {@link toolAllowlist} so
   * the agent can never invoke it directly.
   */
  connectLogin?: {
    /** MCP tool name from `auths.{key}.connect.tool`. */
    toolName: string;
    /** Declared injectable outputs (`connect.produces`) — runner validates against this. */
    produces?: readonly string[];
    /** Auth key the captured session maps to. */
    authKey: string;
    /** Auth type (`custom`, `oauth2`, …) — drives delivery defaults. */
    authType: string;
    /** URL allowlist carried onto the captured session. */
    authorizedUris: readonly string[];
    /** Manifest `delivery.http` block used to render the session header. */
    deliveryHttp: ManifestDeliveryHttp;
    /** Decrypted login secret — sidecar-only, used for proxy-side substitution. */
    inputs: Record<string, string>;
    /**
     * Upstream status codes that trigger a mid-run re-login (from
     * `auths.{key}._meta["dev.appstrate/connect"].reauth_on`). When an upstream
     * returns one of these for a request using the captured session, the
     * sidecar re-runs the login tool to mint a fresh session and retries the
     * request once. Omitted when the manifest didn't declare `reauth_on` —
     * the sidecar defaults to `[401]`.
     */
    reauthOn?: number[];
  };
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
   * Abstract account/tenant identifier surfaced by the integration's
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

/**
 * One ordered, human-readable line in the integration boot trail. The sidecar
 * (which owns the per-phase timings) formats the message; the agent relays it
 * verbatim into the run-event pipeline as an `appstrate.progress` breadcrumb so
 * it lands in `run_logs` for dashboard observability. `data` carries the same
 * facts in structured form for machine consumers.
 */
export interface IntegrationBootBreadcrumb {
  /** e.g. `"@appstrate/bun-toolkit: spawn 120ms · connect 70ms · ready"`. */
  message: string;
  /** Maps to the `run_logs` level on the emitted `appstrate.progress` event. */
  level: "info" | "warn" | "error";
  /** Structured fields (integrationId, durationMs, …) — persisted on the log row. */
  data?: Record<string, unknown>;
}

/**
 * Result of the sidecar's integration boot pass, fetched by the agent from
 * `GET /integrations/boot-report` after the MCP handshake. The agent emits the
 * {@link IntegrationBootBreadcrumb}s for observability and, when `ok` is false,
 * fails the run — the platform principle "an integration that didn't launch as
 * declared aborts the run, every tier".
 */
export interface IntegrationBootReport {
  /** False when any declared integration failed to boot — the agent aborts the run. */
  ok: boolean;
  /** Count of integrations declared via `INTEGRATIONS_TO_SPAWN_JSON`. */
  declared: number;
  /** Runtime adapter that ran the integrations (`"process"` | `"docker"` | `"none"`). */
  adapter: string;
  /** Per-integration success — namespace + count of tools surfaced to the agent. */
  spawned: Array<{ integrationId: string; namespace: string; toolCount: number }>;
  /** Per-integration failure — the error that prevented spawn/connect/register. */
  failed: Array<{ integrationId: string; error: string }>;
  /** Ordered per-phase breadcrumbs for the run-log boot trail. */
  breadcrumbs: IntegrationBootBreadcrumb[];
}
