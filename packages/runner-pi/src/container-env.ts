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
  /** IDs of the providers the agent may call. Serialised as a comma-separated list. */
  connectedProviders?: ReadonlyArray<string>;
  /** Optional JSON Schema injected for constrained decoding. */
  outputSchema?: unknown;
  /** Forward-proxy URL reachable from the agent container. When set, HTTP(S)_PROXY + NO_PROXY are emitted. */
  forwardProxyUrl?: string;
  /** Hosts excluded from the forward proxy. Defaults to `sidecar,localhost,127.0.0.1`. */
  noProxy?: string;
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
  const sidecarUrl = opts.sidecarUrl ?? "http://sidecar:8080";

  const env: Record<string, string> = {
    AGENT_PROMPT: opts.agentPrompt,
    MODEL_API: model.api,
    MODEL_ID: model.modelId,
    SIDECAR_URL: sidecarUrl,
  };

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

  if (opts.forwardProxyUrl) {
    const noProxy = opts.noProxy ?? "sidecar,localhost,127.0.0.1";
    env.HTTP_PROXY = opts.forwardProxyUrl;
    env.HTTPS_PROXY = opts.forwardProxyUrl;
    env.http_proxy = opts.forwardProxyUrl;
    env.https_proxy = opts.forwardProxyUrl;
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }

  return env;
}
