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
  /** Sidecar URL reachable from the agent container (default `http://sidecar:8080`). */
  sidecarUrl?: string;
  /**
   * If set, LLM traffic is routed through `${sidecarProxyUrl}` and
   * MODEL_API_KEY is replaced with {@link RuntimePiModelConfig.apiKeyPlaceholder}
   * before container boot.
   */
  sidecarProxyLlmUrl?: string;
  /**
   * When `true`, no sidecar will be attached to the run. The entrypoint
   * skips the MCP wiring phase entirely (no `provider_call`, `run_history`,
   * `recall_memory` tools), `SIDECAR_URL` is not emitted, and the agent
   * talks to the upstream LLM directly via {@link sidecarProxyLlmUrl} or
   * the model's native baseUrl. Only valid for runs that declare no
   * providers and use a static API key.
   */
  noSidecar?: boolean;
  /** IDs of the providers the agent may call. Serialised as a comma-separated list. */
  connectedProviders?: ReadonlyArray<string>;
  /** Optional JSON Schema injected for constrained decoding. */
  outputSchema?: unknown;
  /** Forward-proxy URL reachable from the agent container. When set, HTTP(S)_PROXY + NO_PROXY are emitted. */
  forwardProxyUrl?: string;
  /**
   * Disable Pi SDK's internal retry loop. Defaults to undefined (SDK
   * retry stays on with `maxRetries: 2`). Opt-in escape hatch for
   * deployments wiring an external retry layer that would otherwise
   * stack with the SDK retry and cause amplification on 429.
   */
  disableModelRetry?: boolean;
  /** Hosts excluded from the forward proxy. Defaults to `sidecar,localhost,127.0.0.1`. */
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
    env.SIDECAR_URL = opts.sidecarUrl ?? "http://sidecar:8080";
  }

  if (opts.runId) env.AGENT_RUN_ID = opts.runId;
  if (opts.agentInput !== undefined) env.AGENT_INPUT = JSON.stringify(opts.agentInput);

  if (opts.connectedProviders && opts.connectedProviders.length > 0) {
    env.CONNECTED_PROVIDERS = opts.connectedProviders.join(",");
  }

  // MODEL_BASE_URL is only emitted when going through a proxy — Pi SDK
  // falls back to upstream defaults when unset, so emitting an empty
  // string would silently override the SDK's per-API defaults.
  if (opts.sidecarProxyLlmUrl) {
    env.MODEL_BASE_URL = opts.sidecarProxyLlmUrl;
  }
  if (model.apiKey) {
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
    const noProxy = opts.noProxy ?? "sidecar,localhost,127.0.0.1";
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

  // Forward the run-trace diagnostic gate so the container's HttpSink +
  // bridge emit their `[run-trace]` stderr lines. Off by default — only
  // a host that sets `APPSTRATE_RUN_TRACE=1` opts in. The platform-side
  // mirror (logger.info `[run-trace]` calls) does not need this flag;
  // it filters by LOG_LEVEL.
  if (process.env["APPSTRATE_RUN_TRACE"] === "1") {
    env.APPSTRATE_RUN_TRACE = "1";
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
  // runtime-side mirror (afps-runtime/.../provider-tool.ts) agrees with
  // the sidecar on what counts as "too large" — otherwise large uploads
  // would fail with a 413 from the sidecar instead of a typed
  // RESOLVER_BODY_TOO_LARGE caught client-side. Only the request-body
  // cap is forwarded; the envelope cap is sidecar-internal and the
  // runtime never builds JSON-RPC envelopes itself.
  Object.assign(env, pickOperatorSidecarEnv(["SIDECAR_MAX_REQUEST_BODY_BYTES"]));

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
