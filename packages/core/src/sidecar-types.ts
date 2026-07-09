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
 * `RunOrchestrator.resolvePlatformApiUrl`. Letting callers supply
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
  /**
   * P4 — connect-run result-channel key. Set only alongside
   * {@link connectLoginSpec}. A base64-encoded 32-byte AES-256 key the
   * launcher generates per connect-run and hands the sidecar (as the
   * `CONNECT_RESULT_KEY` env var) so the sidecar can encrypt the captured
   * credential bundle before writing it to its `APPSTRATE_CONNECT_RESULT:`
   * sentinel line. The sidecar's stdout is captured by the orchestrator (Docker
   * logging driver → log collection in prod); encrypting the bundle keeps the
   * plaintext credential off that surface. The launcher retains the key
   * in-memory and decrypts the sentinel — the key itself is never serialized to
   * the bundle, logged, or persisted. Same trust channel as `connectLoginSpec`
   * (both ride sidecar-spawn env). Omitted for non-connect runs.
   */
  connectResultKey?: string;
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

/**
 * One credential-injecting `api_call` tool — a single auth opted into the
 * `_meta["dev.appstrate/api"]` vendor extension. See
 * {@link IntegrationSpawnSpec.apiCalls}.
 */
export interface ApiCallSpec {
  /** Which declared auth supplies credentials + authorized_uris. */
  authKey: string;
  /**
   * Agent-facing tool name (before the `{namespace}__` prefix). `api_call` for
   * a single opted-in auth; `api_call__{authKey}` when several are opted in.
   */
  toolName: string;
  /** URI allowlist (verbatim from `auths.{authKey}.authorized_uris`). */
  authorizedUris: readonly string[];
  /**
   * Skip the `authorized_uris` allowlist (SSRF blocklist still applies).
   * From `auths.{authKey}.allow_all_uris` — for user-supplied base URLs.
   */
  allowAllUris?: boolean;
  /** Resumable-upload protocols the tool advertises (may be empty). */
  uploadProtocols?: readonly string[];
}

export interface IntegrationSpawnSpec {
  /** Integration package id (e.g. `@appstrate/gmail-mcp`). */
  integrationId: string;
  /** McpHost namespace — tool names are prefixed with `{namespace}__`. */
  namespace: string;
  /**
   * AFPS source kind — peer discriminant for the sidecar's spawn-mode
   * dispatch. Mirrors `manifest.source.kind` from the integration manifest
   * and is the authoritative selector for the local/remote/api branches in
   * `integrations-boot.ts`.
   *
   * Lives at the spawn-spec top level (not on `manifest.server.type`) to
   * keep `manifest.server.type` aligned with the AFPS `mcpServerTypeEnum`
   * (`node|python|binary|uv`) — the previous `manifest.server.type = "http"`
   * sentinel collided with that enum and was an Appstrate-internal protocol
   * field that never appears in a real manifest.
   *
   *   - `"local"`  → spawn a runner container/subprocess from a referenced
   *                  mcp-server bundle.
   *   - `"remote"` → open a Streamable HTTP MCP client against
   *                  `manifest.server.url`; no bundle, no MITM.
   *   - `"none"`   → no MCP backing; the sidecar skips spawn. The only tools
   *                  it can expose are the `api_call` tool(s) declared via the
   *                  `_meta["dev.appstrate/api"]` vendor extension ({@link apiCalls}).
   *                  `manifest.server` is undefined in this case.
   *
   * Note: api_call is ORTHOGONAL to `sourceKind` — a `"local"`/`"remote"`
   * integration can also carry {@link apiCalls} entries.
   */
  sourceKind: "local" | "remote" | "none";
  /** Validated `type: integration` manifest (server, auths). */
  manifest: {
    name: string;
    version: string;
    /**
     * MCP server to spawn/connect. Optional on the spawn spec: the
     * resolver omits it for serverless integrations (`source.kind: "none"`,
     * no `server`), which expose only their `api_call` tool(s) (if any). The
     * sidecar skips spawn entirely for such specs.
     *
     * NOTE: `server.type` here carries the AFPS `mcpServerTypeEnum` value
     * (`node|python|binary|uv`) for local sources only. For remote sources
     * (`sourceKind === "remote"`) it is omitted — the spawn-mode dispatch
     * uses {@link IntegrationSpawnSpec.sourceKind}, NOT `server.type`.
     */
    server?: {
      /**
       * Runner type, sourced from the referenced mcp-server's
       * `server.type` (AFPS `mcpServerTypeEnum`: `node|python|binary|uv`)
       * or the Appstrate `_meta` runtime override. Omitted for remote
       * sources.
       */
      type?: string;
      /**
       * Path (relative to bundle root) of the spawned server's entry. AFPS
       * §7.4 / MCPB calls this field `entry_point` — snake_case on the
       * wire and on the spawn spec to avoid a per-type translation hop
       * (the prior `entryPoint` camelCase was a churn-only divergence
       * from the manifest the spawn-resolver reads).
       */
      entry_point?: string;
      /**
       * AFPS — the SEPARATE `mcp-server` package id this integration's
       * `source.kind: "local"` references (`source.server.name`). The sidecar
       * fetches THIS package's `.afps` bundle (the runnable server code) from
       * `GET /internal/mcp-server-bundle/:scope/:name`, NOT the integration's
       * own bundle. Set for local sources; omitted for remote and serverless
       * integrations.
       */
      packageId?: string;
      /**
       * AFPS — the CONCRETE published version of {@link packageId} that
       * this run resolved at kickoff (from `source.server.version`, via
       * exact → dist-tag → semver-range resolution). The sidecar forwards it
       * to `GET /internal/mcp-server-bundle/:scope/:name?version=…` so the
       * runnable BYTES come from the SAME version as the manifest the
       * spawn-resolver read — eliminating the manifest/bytes version skew and
       * the "publish ≠ deploy" footgun (issue #588). Omitted for system
       * mcp-servers (single version served from the boot registry) and for
       * remote/serverless integrations. When absent, the byte route falls back
       * to the latest non-yanked published version (back-compat).
       */
      version?: string;
      /**
       * AFPS §7.1 — build-provenance flag. `true` means the referenced
       * mcp-server's source is vendored into the integration's own bundle
       * rather than fetched as an independent package (reproducibility +
       * supply-chain audit). Propagated verbatim from
       * `manifest.source.server.vendored` for local sources; omitted for
       * remote and serverless integrations. Surfaced on the sidecar's
       * `IntegrationBootReport.spawned[].vendored` so operators can audit
       * "this run used a vendored foreign package".
       */
      vendored?: boolean;
      /**
       * Phase 7 — remote MCP endpoint URL. Required when
       * {@link IntegrationSpawnSpec.sourceKind} is `"remote"`. The sidecar
       * opens a Streamable HTTP MCP client against this URL instead of
       * spawning a runner. Mutually exclusive with `entry_point` (enforced
       * by `integrationManifestSchema`).
       */
      url?: string;
      /**
       * AFPS §7.1 — remote MCP transport selector. Mirrors the
       * manifest's `source.remote.transport` enum (`"streamable-http" |
       * "sse"`). Defaults to `"streamable-http"` on the sidecar side when
       * absent (back-compat for manifests that predate the enum). Only meaningful when
       * {@link IntegrationSpawnSpec.sourceKind} is `"remote"`.
       */
      transport?: "streamable-http" | "sse";
    };
  };
  /**
   * Generic credential-injecting HTTP tool(s), one per auth opted into the
   * `_meta["dev.appstrate/api"]` vendor extension AND selected by the agent.
   * Orthogonal to {@link sourceKind} — populated for `local`/`remote`/`none`
   * alike. For each entry the sidecar registers a `{namespace}__{toolName}`
   * tool that proxies an arbitrary upstream request bounded by
   * {@link ApiCallSpec.authorizedUris}, injecting the resolved auth's
   * credential header via the same machinery as `delivery.http`.
   *
   * A single opted-in auth → `toolName: "api_call"`; multiple →
   * `toolName: "api_call__{authKey}"` per entry.
   *
   * Credentials are NOT inlined here — the sidecar reads them from the
   * `/internal/integration-credentials` surface (same as MITM / remote
   * HTTP) so a leaked env var can't surface a live token. Omitted when the
   * integration exposes no api_call tool (or the agent selected none).
   */
  apiCalls?: readonly ApiCallSpec[];
  /**
   * Env vars to inject on the spawned subprocess. Resolved from
   * `manifest.auths.{key}.delivery.env` by the platform — values are
   * the live OAuth access_token / API key. Sensitive: never logged.
   */
  spawnEnv: Record<string, string>;
  /**
   * AFPS §7.6 — `delivery.files` mounts. The sidecar materialises each
   * entry into the runner's filesystem at the declared absolute path with the
   * declared POSIX `mode` (default `"0400"`). `content_b64` is the rendered
   * file body (the `{$credential.<field>}` template applied to the credential
   * bag) base64-encoded so binary cert/key material survives the JSON wire.
   *
   * Sensitive (the bytes are the live credential material) — never logged.
   * Omitted when no auth declares `delivery.files`. Used primarily for `mtls`
   * (client cert + key) but available for any auth type whose credential is
   * naturally a file (custom auth, GCP service-account JSON, …).
   *
   * Schema: `<absolute-posix-path>: { content_b64, mode }`. The path key MUST
   * be absolute, MUST NOT contain `..` segments, and MUST NOT collapse to `/`
   * (enforced by the resolver via {@link isSafeDeliveryFilePath} — manifests
   * declaring an unsafe path are skipped with a warning).
   */
  fileMounts?: Record<string, { content_b64: string; mode: string }>;
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
   * Explicit egress signal — `true` when this local-source runner needs a
   * controlled outbound route but NO header injection. A local runner sits on
   * the per-run network (`internal: true` in docker mode) with no direct
   * egress; its only way out is a per-integration listener the sidecar mounts
   * and hands the runner as `HTTPS_PROXY`.
   *
   * Egress is orthogonal to credential injection (issue #543). A
   * `delivery.http` integration gets its egress route from the MITM listener
   * its injection plan already mounts ({@link httpDeliveryAuths}). A
   * `delivery.env` integration (the server authenticates itself, e.g. a
   * form/session login) resolves NO injection plan — this flag tells the
   * sidecar to mount a plain CONNECT egress listener (tunnel + SSRF floor, no
   * TLS termination, no cert mint) so the runner can reach upstream.
   *
   * Never set for `mtls` (the runner must reach upstream directly so the
   * client-cert handshake is not terminated) nor for non-local sources
   * (remote MCP / serverless have no runner). When both this and a non-empty
   * {@link httpDeliveryAuths} are present, the MITM listener wins and provides
   * egress — the sidecar picks ONE listener per integration, MITM-first.
   */
  needsEgress?: boolean;
  /**
   * R8a defensive filter — names from `manifest.hidden_tools` (AFPS
   * §3.4 / `integration.schema.json`). Install-time validation already
   * subtracts these from the agent's tool catalog via
   * {@link resolveIntegrationToolCatalog}, so in the happy path the
   * sidecar's allowlist never references a hidden name. The sidecar
   * applies the same filter at runtime as a belt-and-suspenders guard
   * against misconfigurations that bypass install-time validation
   * (test fixtures, direct DB writes, schema relaxations on disk).
   *
   * Empty / undefined = no extra filtering (the install-time catalog
   * resolution is the authoritative source).
   */
  hiddenTools?: readonly string[];
  /**
   * Niveau 2 Phase 3 — agent-declared MCP tool allowlist. When
   * non-undefined, restricts the set of tools the namespace advertises
   * via `tools/list`. Tools not in the allowlist are silently omitted
   * from `tools/list` and consequently unreachable via `tools/call`
   * (the agent's MCP client never learns of them, so they cannot be
   * named in a call; the sidecar's `McpHost` has no mapping for them
   * either, so a forged call would fail as an unknown tool). An empty
   * array disables the namespace entirely (no tools surfaced).
   *
   * Usually an array — the platform builds it from
   * `dependencies.integrations[id].tools` and defaults to `[]` when the
   * agent author didn't pick any tool (least privilege).
   *
   * AFPS §4.4 wildcard — when the agent set `tools: "*"` (and the
   * integration declares `allow_undeclared_tools: true`, §7.8) the
   * platform emits `undefined` here. The sidecar's `McpHost.register`
   * treats undefined as "no allowlist" and surfaces every tool the
   * upstream advertises — forward-compatible passthrough for remote MCP
   * servers that grow their surface between manifest republishes.
   */
  toolAllowlist?: readonly string[];
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
  /**
   * Per-run shared workspace mount declared on the referenced
   * mcp-server's `_meta["dev.appstrate/workspace"]`. Opt-in: omitted
   * when the mcp-server didn't declare it (the runner has no access
   * to the agent's filesystem — the historical default and current
   * behaviour for every system integration).
   *
   * When present, the sidecar's integration runtime adapter mounts the
   * per-run shared workspace (Docker volume in tier 3, host directory
   * in tier 0-2) at `mount` inside the runner with the requested
   * `access` mode. The actual workspace handle (volume name / host
   * path) travels separately via `WORKSPACE_HANDLE_JSON` on the
   * sidecar's env so a single workspace can back N opt-in runners +
   * the agent without each spec carrying a redundant copy.
   *
   * Only meaningful for `sourceKind: "local"` — remote MCP servers
   * have no runner to mount into; serverless (`source.kind: "none"`)
   * integrations have no runner either. The spawn resolver silently
   * drops this field for non-local sources.
   */
  workspaceMount?: {
    /** Absolute POSIX path inside the runner. Validated by `getMcpServerWorkspaceMount`. */
    readonly mount: string;
    /** `"rw"` allows writes; `"ro"` is the least-privilege default. */
    readonly access: "ro" | "rw";
  };
}

/**
 * Discriminated union covering the two LLM auth modes the sidecar can serve:
 *
 *   - `api_key`: the agent SDK builds the auth header with a placeholder and
 *     the sidecar swaps the placeholder for the real key.
 *   - `oauth`: the no-forging OAuth path for an agent driver that signs its OWN
 *     provider fingerprint (the official Claude Agent SDK binary). The sidecar
 *     fetches a fresh access token from the platform
 *     (`GET /internal/oauth-token/:credentialId`), swaps the request bearer for
 *     it, and ensures the OAuth beta flag — but forges nothing (no identity
 *     headers, no body transforms). There is deliberately no fingerprint-forging
 *     mode: a subscription provider whose driver can't sign its own fingerprint
 *     cannot execute.
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
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "mistral-conversations"
  | "google-generative-ai"
  | "google-vertex"
  | "azure-openai-responses"
  | "bedrock-converse-stream";

/**
 * Model-alias swap (LLM-gateway alias pattern). Present only for model aliases.
 * The agent container is handed the public `alias` as its `MODEL_ID`, so every
 * inference request arrives with `model: <alias>`. The sidecar rewrites it to
 * `<real>` before forwarding upstream, and rewrites the upstream's echoed
 * `model: <real>` back to `<alias>` on the way out — including each streaming
 * chunk. The agent therefore only ever sees the alias; the real backing id
 * stays inside the sidecar (and the platform's private usage ledger).
 *
 * Matching is by exact value at the known JSON locations (top-level `model`,
 * and `message.model` for Anthropic `message_start`), never a blind string
 * replace — so a model id mentioned inside generated content is never clobbered.
 */
export interface ModelSwap {
  /** Public alias id the agent sends (its `MODEL_ID`). */
  alias: string;
  /** Real upstream model id forwarded to the provider. */
  real: string;
}

export interface LlmProxyApiKeyConfig {
  authMode: "api_key";
  /** Upstream provider base URL the sidecar forwards to. */
  baseUrl: string;
  apiKey: string;
  placeholder: string;
  /** Set for model aliases — rewrite `model` alias↔real in req/resp. See {@link ModelSwap}. */
  modelSwap?: ModelSwap;
}

/**
 * OAuth mode — the no-forging path for oauth-subscription runs. The in-container
 * Pi engine (`pi-ai`) emits the provider's own subscription request shape from
 * the OAuth-shaped placeholder token it was given (headers, beta flags,
 * user-agent — request-shape fidelity is delegated to Pi).
 *
 * The sidecar forges nothing. It only resolves a fresh access token from the
 * platform and swaps the request bearer for it verbatim (`applyOauthBearerSwap`)
 * — every other header and the body pass through untouched. There is no forging
 * fallback: the platform itself never synthesises a provider fingerprint.
 */
export interface LlmProxyOauthConfig {
  authMode: "oauth";
  /** Fallback base URL — the sidecar prefers `baseUrl` returned by the platform's token endpoint. */
  baseUrl: string;
  /** ID of the `model_provider_credentials` row backing this OAuth connection. */
  credentialId: string;
  /** Set for model aliases — rewrite `model` alias↔real in req/resp. See {@link ModelSwap}. */
  modelSwap?: ModelSwap;
}

/**
 * Wire-format response from the platform's `GET /internal/oauth-token/:credentialId`
 * (and `POST .../refresh`) endpoint. Carries only the fields that change per
 * refresh — provider invariants (baseUrl, providerId) live in
 * {@link LlmProxyOauthConfig}, which the sidecar already received at boot.
 */
export interface OAuthTokenResponse {
  accessToken: string;
  /** Epoch milliseconds. `null` when expiry is unknown — sidecar treats this as "always refresh". */
  expiresAt: number | null;
  /**
   * Abstract account/tenant identifier surfaced by the integration's
   * `extractTokenIdentity` hook (used at connect time for required-claim
   * validation). This generic OAuth `accountId` metadata is NOT forwarded as an
   * upstream header by the platform.
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
  /**
   * Per-integration success — namespace + count of tools surfaced to the agent.
   * `vendored` mirrors the AFPS §7.1 `source.server.vendored` build-provenance
   * signal forwarded from `IntegrationSpawnSpec.manifest.server.vendored` (set
   * only for local sources; omitted otherwise).
   */
  spawned: Array<{
    integrationId: string;
    namespace: string;
    toolCount: number;
    vendored?: boolean;
  }>;
  /** Per-integration failure — the error that prevented spawn/connect/register. */
  failed: Array<{ integrationId: string; error: string }>;
  /** Ordered per-phase breadcrumbs for the run-log boot trail. */
  breadcrumbs: IntegrationBootBreadcrumb[];
}
