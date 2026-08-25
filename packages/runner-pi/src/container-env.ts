// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The env var contract `runtime-pi/entrypoint.ts` reads when the Docker image
 * boots, shaped once so external consumers do not re-derive the conditionals.
 */

import { createLogger } from "@appstrate/core/logger";
import { ALIAS_CLIENT_API_SHAPE } from "@appstrate/core/model-swap";
import type {
  ModelNativeReasoningLevel,
  ModelReasoningLevel,
} from "@appstrate/core/model-generation";

/**
 * `MODEL_API_KEY` inside an ALIASED container.
 *
 * Constant rather than derived, because the platform's own placeholder is not
 * vendor-neutral: `deriveKeyPlaceholder` deliberately preserves the key's
 * dash-separated prefix so the SDK's prefix-based behaviour keeps working, and
 * for a real key that prefix IS the vendor — `sk-ant-…`, `sk-proj-…`,
 * `sk-or-v1-…`. Emitting it would disclose the exact fact `MODEL_PROVIDER` is
 * withheld to hide, to code that can read its own environment.
 *
 * Safe to make constant: an aliased run always speaks {@link
 * ALIAS_CLIENT_API_SHAPE} to the sidecar, which authenticates with
 * `Authorization: Bearer <key>` and never inspects the value's shape. The
 * sidecar swaps in the real credential upstream, so nothing downstream of the
 * container reads this string either.
 */
export const ALIAS_API_KEY_PLACEHOLDER = "appstrate-placeholder";

export interface RuntimePiModelConfig {
  /** Pi SDK `api` slug — e.g. `"anthropic-messages"`, `"openai-completions"`. */
  api: string;
  modelId: string;
  baseUrl: string;
  /** Real upstream provider id → `MODEL_PROVIDER`. Pass it even for an {@link aliased} run. */
  providerId?: string | null;
  /** LLM API key. When unset, MODEL_API_KEY / MODEL_BASE_URL are not emitted. */
  apiKey?: string;
  /** Stands in for the real apiKey inside the container. Required when LLM traffic is proxied. */
  apiKeyPlaceholder?: string;
  input?: ReadonlyArray<string> | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  reasoningLevelMap?: Partial<Record<ModelReasoningLevel, ModelNativeReasoningLevel>>;
  cost?: unknown | null;
  /**
   * This run's model is a platform ALIAS (`docs/architecture/MODEL_ALIASES.md`).
   * WHICH variables that changes is decided in the masking block of
   * {@link buildRuntimePiEnv}; false means a BYOK run, which hides nothing.
   */
  aliased?: boolean;
}

export interface RuntimePiEnvOptions {
  model: RuntimePiModelConfig;
  /** Effective model-generation controls resolved by the platform. */
  generation?: {
    temperature?: number | null;
    reasoningLevel?: ModelReasoningLevel | null;
  };
  agentPrompt: string;
  runId?: string;
  agentInput?: unknown;
  /** Sidecar URL reachable from the agent container. Required unless {@link noSidecar} — throws. */
  sidecarUrl?: string;
  /** Routes LLM traffic through this URL; MODEL_API_KEY becomes the placeholder. */
  sidecarProxyLlmUrl?: string;
  /** Skips MCP wiring and `SIDECAR_URL`. Only valid with no providers and a static API key. */
  noSidecar?: boolean;
  outputSchema?: unknown;
  /** Forward-proxy URL. When set, HTTP(S)_PROXY + NO_PROXY are emitted. */
  forwardProxyUrl?: string;
  /** Turn off the Pi SDK's retry loop (default on, `maxRetries: 4`) when wiring an external one. */
  disableModelRetry?: boolean;
  /** Hosts excluded from the proxy. Required with {@link forwardProxyUrl} on a sidecar run. */
  noProxy?: string;
  sink?: {
    /** POST target for each {@link RunEvent} — typically `…/api/runs/{runId}/events`. */
    url: string;
    /** POST target for the terminal `RunResult` — typically `…/events/finalize`. */
    finalizeUrl: string;
    /** Ephemeral HMAC secret — ASCII base64url, never persisted on the host. */
    secret: string;
  };
  /** W3C `traceparent` (wire format); the container's event POSTs join that trace. */
  traceparent?: string;
  /** Wall-clock budget in seconds, measured from the run loop start. Omitted if non-positive. */
  timeoutSeconds?: number;
  /** Per-file cap for the outputs sweep; must match the server's `publish_file` ceiling. */
  maxFileBytes?: number;
}

/**
 * Build the exact env dict `runtime-pi/entrypoint.ts` reads at boot. A key is set
 * only when its source is defined — an absent key keeps the SDK default, so an
 * empty string would silently override it.
 *
 * ADDING A KEY HERE IS A DISCLOSURE DECISION when the run is
 * {@link RuntimePiModelConfig.aliased}: the agent can print its own environment.
 * `test/alias-env-allowlist.test.ts` pins the aliased container's complete env as
 * an exact set, and fails on any new key.
 */
export function buildRuntimePiEnv(opts: RuntimePiEnvOptions): Record<string, string> {
  const { model } = opts;

  // An aliased container speaks pi-ai's vendor-neutral protocol instead of the
  // backing's, which is all `MODEL_API` decides. pi-ai re-derives vendor quirks
  // per request from `model.provider` + `model.baseUrl`, so the backing's shape
  // would have the container emit and read that vendor's vocabulary; `pi-messages`
  // has a closed event union, and the sidecar re-originates against the backing.
  const api = model.aliased ? ALIAS_CLIENT_API_SHAPE : model.api;

  const env: Record<string, string> = {
    AGENT_PROMPT: opts.agentPrompt,
    MODEL_API: api,
    MODEL_ID: model.modelId,
  };

  if (!opts.noSidecar) {
    // No fallback: a Docker-shaped default here would silently misroute
    // process/firecracker runs. `IsolationBoundary.sidecarEndpoints` owns topology.
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

  // Where the Pi SDK sends inference: the sidecar LLM proxy when there is one,
  // else the model's native endpoint on a no-sidecar run. Never an empty string —
  // an absent key keeps the SDK's per-`api` default, which misroutes every
  // OpenAI-compatible provider with a custom base URL to api.openai.com.
  if (opts.sidecarProxyLlmUrl) {
    env.MODEL_BASE_URL = opts.sidecarProxyLlmUrl;
  } else if (opts.noSidecar && model.baseUrl) {
    env.MODEL_BASE_URL = model.baseUrl;
  }
  if (model.apiKey) {
    // Fail closed: the sidecar injects the real credential upstream, so the raw
    // key must never cross the boundary the sidecar exists to protect. A caller
    // that forgot the placeholder would leak it into the container silently.
    if (opts.sidecarProxyLlmUrl && !model.apiKeyPlaceholder) {
      throw new Error(
        "buildRuntimePiEnv: model.apiKeyPlaceholder is required when LLM traffic " +
          "is sidecar-proxied (sidecarProxyLlmUrl is set) — refusing to place the " +
          "real provider API key inside the agent container. Supply the placeholder, " +
          "or route the run without the sidecar LLM proxy for a static direct key.",
      );
    }
    // The raw-key fallback is reachable only on the direct path, where the agent
    // talks to the provider itself and needs the real credential.
    const placeholder = model.apiKeyPlaceholder ?? model.apiKey;
    // An aliased run gets a vendor-neutral constant instead — see
    // ALIAS_API_KEY_PLACEHOLDER for why the derived placeholder cannot be used.
    // This is the same withholding the `MODEL_PROVIDER` line below performs,
    // applied to the other env var that carries the vendor.
    env.MODEL_API_KEY = model.aliased ? ALIAS_API_KEY_PLACEHOLDER : placeholder;
  }

  // Which provider Pi is really talking to: a sidecar-proxied run replaces
  // MODEL_BASE_URL with the sidecar's, erasing one of Pi's two detection inputs,
  // and without this the container emits plain-OpenAI shape at every provider.
  // An ALIASED run never emits it — naming the vendor is the leak, and there is
  // nothing left to configure, `pi-messages` having one request shape.
  if (model.providerId && !model.aliased) env.MODEL_PROVIDER = model.providerId;

  // --- Model-alias masking: the one place the alias policy touches the container
  // env contract. An alias withholds `MODEL_PROVIDER`, `MODEL_REASONING_LEVEL_MAP`
  // and `MODEL_COST`, and replaces `MODEL_API` with the canonical dialect.
  // `MODEL_INPUT` and the two token limits go out unchanged: the container needs
  // them — dropping `MODEL_INPUT` silently disables image input — and the exact
  // `usage.input` count it reports out-tells what withholding them could hide.
  if (model.input) env.MODEL_INPUT = JSON.stringify(model.input);
  if (model.contextWindow != null) env.MODEL_CONTEXT_WINDOW = String(model.contextWindow);
  if (model.maxTokens != null) env.MODEL_MAX_TOKENS = String(model.maxTokens);
  if (model.reasoning != null) env.MODEL_REASONING = model.reasoning ? "true" : "false";
  // The native mapping is the VENDOR's own effort vocabulary, and nothing in an
  // aliased container reads it: the portable level crosses the wire as
  // `options.reasoning`, and the sidecar applies the backing's mapping. Sibling
  // `MODEL_REASONING` stays — a container that cannot reason sends no level.
  if (
    !model.aliased &&
    model.reasoningLevelMap &&
    Object.keys(model.reasoningLevelMap).length > 0
  ) {
    env.MODEL_REASONING_LEVEL_MAP = JSON.stringify(model.reasoningLevelMap);
  }
  if (opts.generation?.temperature != null) {
    env.MODEL_TEMPERATURE = String(opts.generation.temperature);
  }
  if (opts.generation?.reasoningLevel != null) {
    env.MODEL_REASONING_LEVEL = opts.generation.reasoningLevel;
  }
  // The published rate card identifies the vendor on its own, so an aliased run is
  // told nothing about price. Safe because `writeRunnerLedgerRow` computes
  // `cost_usd` server-side from `runs.model_cost` and the reported token counts.
  if (!model.aliased && model.cost !== undefined && model.cost !== null) {
    env.MODEL_COST = JSON.stringify(model.cost);
  }

  if (opts.outputSchema !== undefined && opts.outputSchema !== null) {
    env.OUTPUT_SCHEMA = JSON.stringify(opts.outputSchema);
  }

  if (
    opts.maxFileBytes !== undefined &&
    Number.isFinite(opts.maxFileBytes) &&
    opts.maxFileBytes > 0
  ) {
    env.FILE_MAX_BYTES = String(opts.maxFileBytes);
  }

  if (opts.forwardProxyUrl && !opts.noSidecar) {
    // Same invariant as sidecarUrl above: the exclusion list names the sidecar's
    // own host, which only the orchestrator knows.
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

  // Forward the sidecar caps so the container's runtime-side mirror agrees on what
  // is too large; otherwise a big upload fails with a raw 413 instead of a typed
  // RESOLVER_BODY_TOO_LARGE caught client-side.
  Object.assign(
    env,
    pickOperatorSidecarEnv(["SIDECAR_MAX_REQUEST_BODY_BYTES", "APPSTRATE_MCP_TOOL_TIMEOUT_MS"]),
  );

  // Tool results are truncated at WRITE time, before the event sink, so this is the
  // only knob controlling how much survives into `run_logs`. Keep it below the
  // platform's 32 KB `run_logs.data` cap.
  {
    const toolResultLimit = process.env.TOOL_RESULT_BYTE_LIMIT;
    if (toolResultLimit !== undefined && toolResultLimit !== "") {
      env.TOOL_RESULT_BYTE_LIMIT = toolResultLimit;
    }
  }

  return env;
}

/**
 * Operator-tunable env vars the API host forwards from its own `process.env` into
 * spawned containers. Defaults live in `runtime-pi/sidecar/helpers.ts`.
 */
export const SIDECAR_OPERATOR_ENV_KEYS = [
  "SIDECAR_MAX_REQUEST_BODY_BYTES",
  "SIDECAR_MAX_MCP_ENVELOPE_BYTES",
  // Runner image refs per MCPB `server.type`, consumed sidecar-side. Absent keys
  // fall back to bare `:latest` (local dev); production sets versioned GHCR refs.
  "RUNNER_IMAGE_NODE",
  "RUNNER_IMAGE_BUN",
  "RUNNER_IMAGE_PYTHON",
  "RUNNER_IMAGE_UV",
  "RUNNER_IMAGE_BINARY",
  // Per-call MCP tool timeout, read on BOTH legs of a tool call (sidecar-side and
  // agent-side), so one operator knob widens both. Absent → the MCP SDK default.
  "APPSTRATE_MCP_TOOL_TIMEOUT_MS",
  // The four below are read INSIDE the sidecar process. Under
  // RUN_ADAPTER=docker/firecracker its env is built from `pickOperatorSidecarEnv()`
  // alone rather than inherited, so a key missing here is silently ignored there.
  "LOG_LEVEL",
  "SIDECAR_API_CALL_CONCURRENCY",
  "SIDECAR_INLINE_TOOL_OUTPUT_TOKENS",
  "SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS",
] as const;

export type SidecarOperatorEnvKey = (typeof SIDECAR_OPERATOR_ENV_KEYS)[number];

// Core pino logger read straight from LOG_LEVEL: this module is in the firecracker
// daemon's dependency closure and must not drag in the platform logger's schema.
const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * The operator keys parsed as a positive integer somewhere on the boot path, and
 * would throw on. The rest are used verbatim or already degrade safely.
 *
 * Four of the five are parsed by the sidecar itself. `SIDECAR_MAX_REQUEST_BODY_BYTES`
 * is not any more — see {@link pickOperatorSidecarEnv} — but it belongs in the set
 * all the same: it is still parsed strictly, just earlier and by another module.
 */
const NUMERIC_SIDECAR_ENV_KEYS = new Set<SidecarOperatorEnvKey>([
  "SIDECAR_MAX_REQUEST_BODY_BYTES",
  "SIDECAR_MAX_MCP_ENVELOPE_BYTES",
  "SIDECAR_API_CALL_CONCURRENCY",
  "SIDECAR_INLINE_TOOL_OUTPUT_TOKENS",
  "SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS",
]);

/**
 * What `readPositiveIntEnv` (`runtime-pi/sidecar/helpers.ts`) requires before it
 * returns instead of throwing, minus the per-key ceiling — no stricter, no looser.
 */
function isPositiveIntegerEnvValue(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0;
}

/**
 * Read the operator-tunable env vars from the host's `process.env` into a record
 * to spread into a container env; empty and undefined values are omitted.
 *
 * Omitting MALFORMED numeric values is load-bearing, not defensive, for four of the
 * five {@link NUMERIC_SIDECAR_ENV_KEYS}: `SIDECAR_MAX_MCP_ENVELOPE_BYTES`,
 * `SIDECAR_API_CALL_CONCURRENCY` and the two token budgets. The sidecar parses those
 * with `readPositiveIntEnv` (`runtime-pi/sidecar/helpers.ts`), which THROWS at module
 * scope on the boot path, inside no `try`. One stale `=0` reaching the container would
 * kill the sidecar process and fail every run; dropping it here keeps runs alive on the
 * compiled default.
 *
 * `SIDECAR_MAX_REQUEST_BODY_BYTES` is the exception, and this filter is NOT what
 * protects it any more. Its sole parser now lives in `@appstrate/afps-runtime/resolvers`
 * (`http-call-core.ts`), which THIS process evaluates at module init — verified: both
 * callers of this function, the API host and `modules/firecracker/runner/daemon.ts`,
 * fail to boot on a malformed value long before they get here, so the warn-and-drop
 * below is only ever reached for that key with a value that already parsed. Deliberate,
 * not an oversight: `docs/ENV.md` promises loud-fail at boot on an invalid value, and a
 * cap the operator believes they raised and did not is worse than a refusal to start.
 *
 * Either way this is not the whole check — a value passing here can still exceed a
 * per-key `ABSOLUTE_BODY_CEILING` and throw in the sidecar.
 */
export function pickOperatorSidecarEnv(
  keys: readonly SidecarOperatorEnvKey[] = SIDECAR_OPERATOR_ENV_KEYS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined || value === "") continue;
    if (NUMERIC_SIDECAR_ENV_KEYS.has(key) && !isPositiveIntegerEnvValue(value)) {
      logger.warn(
        "operator env var is not a positive integer — not forwarding it to the sidecar, " +
          "which will use its compiled default",
        { key, value },
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}
