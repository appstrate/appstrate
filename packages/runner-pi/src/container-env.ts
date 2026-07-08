// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The env var contract that `runtime-pi/entrypoint.ts` reads when the
 * Docker image boots. Keeping a single helper that shapes this dict
 * means the contract is documented once and any external consumer
 * (GitHub Action, CLI, self-hosted runner) gets the exact same set of
 * variables without re-deriving conditionals (empty strings, JSON
 * serialisation, boolean casing) on their own.
 */

export interface RuntimePiModelConfig {
  /** Pi SDK `api` slug — e.g. `"anthropic-messages"`, `"openai-completions"`. */
  api: string;
  /** Model identifier passed to the SDK. */
  modelId: string;
  /** Upstream base URL (routed through the sidecar proxy when `apiKey` is set). */
  baseUrl: string;
  /** LLM API key. When unset, MODEL_API_KEY / MODEL_BASE_URL are not emitted. */
  apiKey?: string;
  /** Placeholder used in place of the real apiKey inside the container. */
  apiKeyPlaceholder?: string;
  input?: ReadonlyArray<string> | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: unknown | null;
}

export interface RuntimePiEnvOptions {
  model: RuntimePiModelConfig;
  /** Full enriched system prompt fed to the Pi SDK. */
  agentPrompt: string;
  /** Run identifier. Bundled tools + the entrypoint surface it in every emitted {@link RunEvent}. */
  runId?: string;
  /** JSON-encoded user input passed to the agent (`AGENT_INPUT`). */
  agentInput?: unknown;
  /**
   * Sidecar URL reachable from the agent container. Required unless
   * {@link noSidecar}: the orchestrator owns the topology (Docker DNS
   * alias, host loopback port, in-guest loopback for microVMs) — there
   * is deliberately no default, a missing value throws at build time.
   */
  sidecarUrl?: string;
  /**
   * If set, LLM traffic is routed through `${sidecarProxyUrl}` and
   * MODEL_API_KEY is replaced with {@link RuntimePiModelConfig.apiKeyPlaceholder}
   * before container boot.
   */
  sidecarProxyLlmUrl?: string;
  /**
   * When `true`, no sidecar will be attached to the run. The entrypoint
   * skips the MCP wiring phase entirely (no `{ns}__api_call`, `run_history`,
   * `recall_memory` tools), `SIDECAR_URL` is not emitted, and the agent
   * talks to the upstream LLM directly via {@link sidecarProxyLlmUrl} or
   * the model's native baseUrl. Only valid for runs that declare no
   * providers and use a static API key.
   */
  noSidecar?: boolean;
  /** Optional JSON Schema injected for constrained decoding. */
  outputSchema?: unknown;
  /** Forward-proxy URL reachable from the agent container. When set, HTTP(S)_PROXY + NO_PROXY are emitted. */
  forwardProxyUrl?: string;
  /**
   * Disable Pi SDK's internal retry loop. Defaults to undefined (SDK
   * retry stays on with `maxRetries: 4`). Opt-in escape hatch for
   * deployments wiring an external retry layer that would otherwise
   * stack with the SDK retry and cause amplification on 429.
   */
  disableModelRetry?: boolean;
  /**
   * Hosts excluded from the forward proxy. Required when
   * {@link forwardProxyUrl} is set on a sidecar-backed run — like
   * {@link sidecarUrl}, the exclusion list is topology (which hostname
   * the sidecar answers on), so the orchestrator must supply it.
   */
  noProxy?: string;
  /**
   * Credentials for the container to post signed {@link RunEvent}s back to
   * the platform. When set, `runtime-pi/entrypoint.ts` instantiates an
   * HttpSink against these URLs; the platform no longer parses container
   * stdout. Both URLs must be reachable from inside the container
   * (typically `http://host.docker.internal:3000/...` in Docker-for-Mac or
   * the platform-container hostname on a Docker bridge network).
   */
  sink?: {
    /** POST target for each {@link RunEvent} — typically `…/api/runs/{runId}/events`. */
    url: string;
    /** POST target for the terminal `RunResult` — typically `…/api/runs/{runId}/events/finalize`. */
    finalizeUrl: string;
    /** Ephemeral HMAC secret — ASCII base64url, never persisted on the host. */
    secret: string;
  };
  /**
   * W3C `traceparent` header (wire format) of the request that spawned
   * the run. When set, every event/finalize POST emitted by the
   * container becomes a child span of that trace, enabling end-to-end
   * correlation across the platform → runner → sidecar boundary.
   * Forwarded as `TRACEPARENT` env var, consumed by HttpSink at boot.
   */
  traceparent?: string;
  /**
   * Wall-clock execution budget for the run, in seconds. Forwarded as
   * `AGENT_TIMEOUT_SECONDS`; the entrypoint surfaces it on
   * `ExecutionContext.timeoutSeconds`, where the runner arms its own
   * timeout watchdog (measured from the run loop start, so boot is
   * excluded). Omitted when absent or non-positive — the platform's own
   * container watchdog stays the only backstop.
   */
  timeoutSeconds?: number;
}

/**
 * Build the exact env dict `runtime-pi/entrypoint.ts` reads at boot.
 *
 * Conditional keys (MODEL_INPUT, MODEL_COST, OUTPUT_SCHEMA, etc.) are
 * only set when their source is defined — the entrypoint falls back to
 * SDK defaults when a key is absent, so emitting an empty string would
 * silently override the default.
 */
export function buildRuntimePiEnv(opts: RuntimePiEnvOptions): Record<string, string> {
  const { model } = opts;

  const env: Record<string, string> = {
    AGENT_PROMPT: opts.agentPrompt,
    MODEL_API: model.api,
    MODEL_ID: model.modelId,
  };

  if (!opts.noSidecar) {
    // No fallback: a Docker-shaped magic default here would silently
    // misroute process/firecracker runs. The orchestrator's
    // `IsolationBoundary.sidecarEndpoints` is the single topology owner.
    if (!opts.sidecarUrl) {
      throw new Error(
        "buildRuntimePiEnv: sidecarUrl is required for sidecar-backed runs " +
          "(pass the boundary's sidecarEndpoints.sidecarUrl, or set noSidecar: true)",
      );
    }
    env.SIDECAR_URL = opts.sidecarUrl;
  }

  if (opts.runId) env.AGENT_RUN_ID = opts.runId;
  if (opts.agentInput !== undefined) env.AGENT_INPUT = JSON.stringify(opts.agentInput);
  if (
    opts.timeoutSeconds !== undefined &&
    Number.isFinite(opts.timeoutSeconds) &&
    opts.timeoutSeconds > 0
  ) {
    env.AGENT_TIMEOUT_SECONDS = String(opts.timeoutSeconds);
  }

  // MODEL_BASE_URL tells the Pi SDK where to send inference. Two cases set it:
  //   1. Sidecar-backed run — point at the sidecar LLM proxy, which injects the
  //      real credential and forwards to the upstream provider.
  //   2. No-sidecar run (static API key, no integrations/proxy) — the agent talks
  //      to the provider directly, so it needs the model's native endpoint.
  // Without (2), MODEL_BASE_URL stays empty and the entrypoint falls back to the
  // Pi SDK's per-`api` default (api.openai.com for `openai-*`), which silently
  // misroutes every OpenAI-compatible provider with a custom base URL (DeepSeek,
  // Mistral, z.ai, OpenRouter, …) to OpenAI. See issue #741.
  // We never emit an empty string: an absent key keeps the SDK default for the
  // few providers whose native default is already correct.
  if (opts.sidecarProxyLlmUrl) {
    env.MODEL_BASE_URL = opts.sidecarProxyLlmUrl;
  } else if (opts.noSidecar && model.baseUrl) {
    env.MODEL_BASE_URL = model.baseUrl;
  }
  if (model.apiKey) {
    // Fail closed on the sidecar-proxied path. When LLM traffic is routed
    // through the sidecar LLM proxy (`sidecarProxyLlmUrl` is set), the sidecar
    // injects the real credential upstream and the container must only ever
    // see the placeholder — the raw key must never cross the isolation
    // boundary the sidecar exists to protect. A caller that forgets the
    // placeholder here would silently leak the real provider key into the
    // agent container, so we throw rather than fall back to `model.apiKey`.
    if (opts.sidecarProxyLlmUrl && !model.apiKeyPlaceholder) {
      throw new Error(
        "buildRuntimePiEnv: model.apiKeyPlaceholder is required when LLM traffic " +
          "is sidecar-proxied (sidecarProxyLlmUrl is set) — refusing to place the " +
          "real provider API key inside the agent container. Supply the placeholder, " +
          "or route the run without the sidecar LLM proxy for a static direct key.",
      );
    }
    // The raw-key fallback is only reachable on the direct (non-proxied) path,
    // where the agent talks to the provider itself and legitimately needs the
    // real credential.
    const placeholder = model.apiKeyPlaceholder ?? model.apiKey;
    env.MODEL_API_KEY = placeholder;
  }

  if (model.input) env.MODEL_INPUT = JSON.stringify(model.input);
  if (model.contextWindow != null) env.MODEL_CONTEXT_WINDOW = String(model.contextWindow);
  if (model.maxTokens != null) env.MODEL_MAX_TOKENS = String(model.maxTokens);
  if (model.reasoning != null) env.MODEL_REASONING = model.reasoning ? "true" : "false";
  if (model.cost !== undefined && model.cost !== null) {
    env.MODEL_COST = JSON.stringify(model.cost);
  }

  if (opts.outputSchema !== undefined && opts.outputSchema !== null) {
    env.OUTPUT_SCHEMA = JSON.stringify(opts.outputSchema);
  }

  if (opts.forwardProxyUrl && !opts.noSidecar) {
    // Same invariant as sidecarUrl above: the exclusion list names the
    // sidecar's own host, which only the orchestrator knows.
    const { noProxy } = opts;
    if (!noProxy) {
      throw new Error(
        "buildRuntimePiEnv: noProxy is required when forwardProxyUrl is set " +
          "(pass the boundary's sidecarEndpoints.noProxy)",
      );
    }
    env.HTTP_PROXY = opts.forwardProxyUrl;
    env.HTTPS_PROXY = opts.forwardProxyUrl;
    env.http_proxy = opts.forwardProxyUrl;
    env.https_proxy = opts.forwardProxyUrl;
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }

  if (opts.disableModelRetry) {
    env.MODEL_RETRY_ENABLED = "false";
  }

  if (opts.sink) {
    env.APPSTRATE_SINK_URL = opts.sink.url;
    env.APPSTRATE_SINK_FINALIZE_URL = opts.sink.finalizeUrl;
    env.APPSTRATE_SINK_SECRET = opts.sink.secret;
  }

  if (opts.traceparent) {
    env.TRACEPARENT = opts.traceparent;
  }

  // Forward operator-tunable sidecar caps so the agent container's
  // runtime-side mirror (afps-runtime/.../http-call-core.ts) agrees with
  // the sidecar on what counts as "too large" — otherwise large uploads
  // would fail with a 413 from the sidecar instead of a typed
  // RESOLVER_BODY_TOO_LARGE caught client-side. The envelope cap stays
  // sidecar-internal (the runtime never builds JSON-RPC envelopes). The
  // tool-timeout knob (#779) rides along so the agent→sidecar leg honours
  // the same per-call budget as the sidecar→runner leg.
  Object.assign(
    env,
    pickOperatorSidecarEnv(["SIDECAR_MAX_REQUEST_BODY_BYTES", "APPSTRATE_MCP_TOOL_TIMEOUT_MS"]),
  );

  // Forward the operator-tunable tool-result truncation cap (read by
  // `truncateToolResult` in pi-runner.ts). Tool results are truncated at
  // WRITE time before they reach the event sink / `run_logs`, so this is
  // the only knob that controls how much of a tool result survives into
  // `getRunLogs`. Absent or empty → the runner's compiled 2048-byte
  // default. Keep below the platform's 32 KB `run_logs.data` cap.
  {
    const toolResultLimit = process.env.TOOL_RESULT_BYTE_LIMIT;
    if (toolResultLimit !== undefined && toolResultLimit !== "") {
      env.TOOL_RESULT_BYTE_LIMIT = toolResultLimit;
    }
  }

  return env;
}

/**
 * Operator-tunable env vars that the API host forwards from its own
 * `process.env` into spawned sidecar / agent containers. Sidecar-side
 * defaults live in `runtime-pi/sidecar/helpers.ts`; absent keys mean
 * "use the compiled default".
 */
export const SIDECAR_OPERATOR_ENV_KEYS = [
  "SIDECAR_MAX_REQUEST_BODY_BYTES",
  "SIDECAR_MAX_MCP_ENVELOPE_BYTES",
  // Runner image refs per MCPB `server.type`. Consumed sidecar-side by
  // `integration-runtime-adapter-docker.resolveRunnerImage`; absent keys
  // fall back to the adapter's bare `:latest` defaults (local dev). In
  // production these carry the versioned GHCR refs so the sidecar can
  // `docker create` runner containers without a Docker Hub pull.
  "RUNNER_IMAGE_NODE",
  "RUNNER_IMAGE_BUN",
  "RUNNER_IMAGE_PYTHON",
  "RUNNER_IMAGE_UV",
  "RUNNER_IMAGE_BINARY",
  // Per-call MCP tool timeout override (#779 annex). Consumed sidecar-side
  // (integration clients, `integrations-boot.toolTimeoutMsFromEnv`) and
  // agent-side (`runtime-pi/env.ts` → entrypoint's sidecar client), so a
  // single operator knob widens BOTH legs of a tool call. Absent → the
  // MCP SDK default applies on each leg.
  "APPSTRATE_MCP_TOOL_TIMEOUT_MS",
] as const;

export type SidecarOperatorEnvKey = (typeof SIDECAR_OPERATOR_ENV_KEYS)[number];

/**
 * Read the operator-tunable env vars from the host's `process.env` and
 * return a record suitable for spreading into a container env. Empty
 * and undefined values are omitted so the container falls back to the
 * compiled defaults rather than seeing an empty string (which would
 * fail `readPositiveByteEnv` validation and crash the sidecar at boot).
 *
 * Restrict the returned set with `keys` when only a subset is relevant
 * (e.g. the agent container only needs the request-body cap).
 */
export function pickOperatorSidecarEnv(
  keys: readonly SidecarOperatorEnvKey[] = SIDECAR_OPERATOR_ENV_KEYS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}
