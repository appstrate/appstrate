// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Validated env contract for `runtime-pi/entrypoint.ts`.
 *
 * Every variable read by the bootloader is parsed once here, with
 * fail-fast structured errors at boot. The platform-side writer is
 * `@appstrate/runner-pi/buildRuntimePiEnv`; this reader is its mirror.
 *
 * Why a hand-rolled mini-validator instead of Zod: `runtime-pi` is
 * bundled into the Docker image only (never published to npm). Adding
 * Zod here would inflate the image for a path that runs once per agent
 * boot. The shape is shallow (presence + type + URL/JSON parse), which
 * fits a small validator without losing safety.
 */

export interface RuntimeEnv {
  /** Run identifier injected by the platform on container create. */
  runId: string;
  /** Workspace root inside the container. */
  workspaceDir: string;
  /** Pi SDK API slug — e.g. `"anthropic-messages"`, `"openai-completions"`. */
  modelApi: string;
  /** Model identifier passed to the SDK. */
  modelId: string;
  /** Optional baseUrl override (sidecar proxy or compatible endpoint). */
  modelBaseUrl?: string;
  /** Bearer key for the upstream LLM (placeholder when proxied). */
  modelApiKey?: string;
  /** Whether the model emits reasoning tokens. */
  modelReasoning: boolean;
  /** Pi SDK input modalities. */
  modelInput: ReadonlyArray<"text" | "image">;
  /** Per-token cost (input/output/cacheRead/cacheWrite USD). */
  modelCost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Pi SDK context window in tokens. */
  modelContextWindow: number;
  /** Pi SDK max completion tokens. */
  modelMaxTokens: number;
  /** Full enriched system prompt. */
  agentPrompt: string;
  /** Optional user input — JSON-decoded, defaults to `{}` on absent or malformed. */
  agentInput: Record<string, unknown>;
  /** Sink credentials (HTTP-signed CloudEvents transport to the platform). */
  sink: { url: string; finalizeUrl: string; secret: string };
  /** Sidecar URL — present when the platform attached a sidecar. */
  sidecarUrl?: string;
  /** Heartbeat ping interval (ms). */
  heartbeatIntervalMs: number;
  /** Optional output JSON schema for constrained decoding (raw string — Pi SDK consumes it directly). */
  outputSchemaRaw?: string;
  /**
   * W3C `traceparent` value (header wire format). When the platform
   * spawned the run inside an existing trace, this is forwarded so the
   * container's outbound HTTP traffic — events, finalize, sidecar
   * proxy — becomes child spans of that trace. Validated lightly: any
   * non-empty string is accepted; HttpSink does the strict W3C parse
   * and falls back to a fresh trace on malformed values.
   */
  traceparent?: string;
  /**
   * Phase 2 of #276 feature flag. When `true`, sidecar-backed tools
   * (provider_call, run_history) route through the sidecar's `/mcp`
   * endpoint via JSON-RPC instead of bespoke `/proxy` + `/run-history`
   * routes. Defaults to `false` so the soak window is opt-in until
   * the flag flips at end of Phase 2 soak. Rollback = redeploy with
   * the flag off; no DB migration, no file format change.
   */
  runtimeMcpClient: boolean;
  /**
   * Per-run Bearer token for the MCP HTTP transport. When unset, the
   * MCP client connects unauthenticated — relies on Docker network
   * isolation only. Reuses the platform's existing `RUN_TOKEN` env to
   * avoid minting a separate secret.
   */
  runToken?: string;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const KNOWN_MODEL_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "azure-openai-responses",
  "bedrock-converse-stream",
]);

export class RuntimeEnvError extends Error {
  override readonly name = "RuntimeEnvError";
  readonly issues: ReadonlyArray<string>;
  constructor(issues: ReadonlyArray<string>) {
    super(`runtime-pi env invalid:\n  - ${issues.join("\n  - ")}`);
    this.issues = issues;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseJsonRecord(name: string, raw: string, issues: string[]): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push(
        `${name}: must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
      );
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    issues.push(`${name}: malformed JSON — ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function parseModelInput(
  raw: string | undefined,
  issues: string[],
): ReadonlyArray<"text" | "image"> {
  if (!raw) return ["text"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push(
      `MODEL_INPUT: malformed JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
    return ["text"];
  }
  if (!Array.isArray(parsed)) {
    issues.push(`MODEL_INPUT: must be a JSON array of "text" | "image"`);
    return ["text"];
  }
  const out: Array<"text" | "image"> = [];
  for (const v of parsed) {
    if (v === "text" || v === "image") out.push(v);
    else issues.push(`MODEL_INPUT: invalid modality "${String(v)}" (allowed: "text", "image")`);
  }
  return out.length > 0 ? out : ["text"];
}

function parseModelCost(
  raw: string | undefined,
  issues: string[],
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const fallback = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push(`MODEL_COST: malformed JSON — ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push(`MODEL_COST: must be a JSON object`);
    return fallback;
  }
  const obj = parsed as Record<string, unknown>;
  const num = (key: string) => {
    const v = obj[key];
    if (v === undefined) return 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      issues.push(`MODEL_COST.${key}: must be a non-negative finite number`);
      return 0;
    }
    return v;
  };
  return {
    input: num("input"),
    output: num("output"),
    cacheRead: num("cacheRead"),
    cacheWrite: num("cacheWrite"),
  };
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  issues: string[],
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    issues.push(`${name}: must be a positive integer (got "${raw}")`);
    return fallback;
  }
  return n;
}

/**
 * Parse + validate the runtime-pi env vars from a source object.
 *
 * Throws {@link RuntimeEnvError} listing every issue at once (better
 * DX than failing on the first missing var). Defaults match the
 * pre-validation behaviour of the legacy entrypoint.
 */
export function parseRuntimeEnv(source: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const issues: string[] = [];

  const runId = source.AGENT_RUN_ID;
  if (!runId) issues.push("AGENT_RUN_ID: required");

  const sinkUrl = source.APPSTRATE_SINK_URL;
  if (!sinkUrl) issues.push("APPSTRATE_SINK_URL: required");
  else if (!isHttpUrl(sinkUrl))
    issues.push(`APPSTRATE_SINK_URL: must be an http(s) URL (got "${sinkUrl}")`);

  const sinkFinalizeUrl = source.APPSTRATE_SINK_FINALIZE_URL;
  if (!sinkFinalizeUrl) issues.push("APPSTRATE_SINK_FINALIZE_URL: required");
  else if (!isHttpUrl(sinkFinalizeUrl))
    issues.push(`APPSTRATE_SINK_FINALIZE_URL: must be an http(s) URL (got "${sinkFinalizeUrl}")`);

  const sinkSecret = source.APPSTRATE_SINK_SECRET;
  if (!sinkSecret) issues.push("APPSTRATE_SINK_SECRET: required");
  else if (sinkSecret.length < 16)
    issues.push(`APPSTRATE_SINK_SECRET: too short (${sinkSecret.length} chars, expected ≥ 16)`);

  const modelApi = source.MODEL_API;
  if (!modelApi) issues.push("MODEL_API: required");
  else if (!KNOWN_MODEL_APIS.has(modelApi))
    issues.push(
      `MODEL_API: unknown api "${modelApi}" (allowed: ${[...KNOWN_MODEL_APIS].join(", ")})`,
    );

  const modelId = source.MODEL_ID;
  if (!modelId) issues.push("MODEL_ID: required");

  const agentPrompt = source.AGENT_PROMPT;
  if (!agentPrompt) issues.push("AGENT_PROMPT: required");

  const sidecarUrl = source.SIDECAR_URL;
  if (sidecarUrl !== undefined && sidecarUrl !== "" && !isHttpUrl(sidecarUrl)) {
    issues.push(`SIDECAR_URL: must be an http(s) URL when set (got "${sidecarUrl}")`);
  }

  const modelBaseUrl = source.MODEL_BASE_URL;
  if (modelBaseUrl && !isHttpUrl(modelBaseUrl))
    issues.push(`MODEL_BASE_URL: must be an http(s) URL when set (got "${modelBaseUrl}")`);

  const agentInput = source.AGENT_INPUT
    ? parseJsonRecord("AGENT_INPUT", source.AGENT_INPUT, issues)
    : {};

  const modelInput = parseModelInput(source.MODEL_INPUT, issues);
  const modelCost = parseModelCost(source.MODEL_COST, issues);
  const modelContextWindow = parsePositiveInt(
    "MODEL_CONTEXT_WINDOW",
    source.MODEL_CONTEXT_WINDOW,
    DEFAULT_CONTEXT_WINDOW,
    issues,
  );
  const modelMaxTokens = parsePositiveInt(
    "MODEL_MAX_TOKENS",
    source.MODEL_MAX_TOKENS,
    DEFAULT_MAX_TOKENS,
    issues,
  );
  const heartbeatIntervalMs = parsePositiveInt(
    "APPSTRATE_HEARTBEAT_INTERVAL_MS",
    source.APPSTRATE_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    issues,
  );

  if (issues.length > 0) throw new RuntimeEnvError(issues);

  return {
    runId: runId!,
    workspaceDir: source.WORKSPACE_DIR || "/workspace",
    modelApi: modelApi!,
    modelId: modelId!,
    modelBaseUrl: modelBaseUrl || undefined,
    modelApiKey: source.MODEL_API_KEY || undefined,
    modelReasoning: source.MODEL_REASONING === "true",
    modelInput,
    modelCost,
    modelContextWindow,
    modelMaxTokens,
    agentPrompt: agentPrompt!,
    agentInput,
    sink: { url: sinkUrl!, finalizeUrl: sinkFinalizeUrl!, secret: sinkSecret! },
    sidecarUrl: sidecarUrl || undefined,
    heartbeatIntervalMs,
    outputSchemaRaw: source.OUTPUT_SCHEMA || undefined,
    traceparent: source.TRACEPARENT || undefined,
    runtimeMcpClient: source.RUNTIME_MCP_CLIENT === "1" || source.RUNTIME_MCP_CLIENT === "true",
    runToken: source.RUN_TOKEN || undefined,
  };
}
