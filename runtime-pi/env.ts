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

import { getErrorMessage } from "@appstrate/core/errors";
import { MODEL_API_SHAPES } from "@appstrate/core/sidecar-types";
import {
  modelNativeReasoningLevelSchema,
  modelReasoningLevelSchema,
  type ModelNativeReasoningLevel,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";

interface RuntimeEnv {
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
  /** Explicit generation controls; absent preserves Pi's historical defaults. */
  modelTemperature?: number;
  modelReasoningLevel?: ModelReasoningLevel;
  modelReasoningLevelMap?: Partial<Record<ModelReasoningLevel, ModelNativeReasoningLevel>>;
  /**
   * Appstrate model-provider id of the real upstream (`MODEL_PROVIDER`). On a
   * proxied run `MODEL_BASE_URL` points at the sidecar, so this is what lets
   * Pi still recognise the provider and emit its request shape. Absent on an
   * older platform — the api shape's generic key is the fallback.
   */
  modelProvider?: string;
  /** Pi SDK input modalities. */
  modelInput: ReadonlyArray<"text" | "image">;
  /**
   * Per-token cost (input/output/cacheRead/cacheWrite USD), or ABSENT when the
   * platform resolved no rates for this model — an unpriced model, or an
   * aliased one whose rate card is withheld on purpose (the published card
   * names the vendor). Absent means absent all the way down: the run reports no
   * cost rather than a fabricated 0. See {@link parseModelCost}.
   */
  modelCost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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
  /**
   * Wall-clock execution budget for the run, in seconds. Surfaced on
   * `ExecutionContext.timeoutSeconds`; the runner arms its own timeout
   * watchdog from it (boot excluded). Absent when the platform did not
   * forward `AGENT_TIMEOUT_SECONDS` — no runner-side enforcement.
   */
  timeoutSeconds?: number;
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
   * Optional per-call MCP tool timeout for the agent→sidecar client
   * (#779 annex). Third-party integration servers doing a cold OAuth
   * refresh on their first tool call can legitimately outlive the MCP
   * SDK default; the same `APPSTRATE_MCP_TOOL_TIMEOUT_MS` operator knob
   * is honoured sidecar-side, so both legs share one budget. Absent →
   * `undefined` → SDK default.
   */
  mcpToolTimeoutMs?: number;
  /**
   * NON-FATAL boot diagnostics — the counterpart of {@link RuntimeEnvError}'s
   * fatal `issues`. A value that is present but malformed is a contract
   * violation and must stop the run; a value whose ABSENCE silently degrades
   * accounting must only be reported. Empty on a fully specified environment.
   *
   * Kept as a separate channel rather than folded into `issues` on purpose:
   * `issues` is thrown (`entrypoint.ts` → `process.exit(1)`), so pushing an
   * absent `MODEL_COST` there would turn every unpriced model into a crashed
   * run — a pricing gap must not become an outage.
   */
  warnings: string[];
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

// Fixed timings, deliberately NOT operator knobs. Both were parsed from
// `APPSTRATE_HEARTBEAT_INTERVAL_MS` / `APPSTRATE_MCP_CONNECT_DEADLINE_MS` and
// documented as tunable, but no writer has ever existed on any topology: the
// agent container's environment is exactly what `buildRuntimePiEnv()` returns,
// neither key is in `SIDECAR_OPERATOR_ENV_KEYS`, and the process orchestrator's
// allowlist carries no `APPSTRATE_*` at all. Setting either in a shell was a
// no-op that read as configuration. Changing them is a code change; if an
// operator knob is ever genuinely wanted, add the key to the platform-side
// allowlist in the same commit that reintroduces the parse.

/** Heartbeat ping interval against `{SINK_URL}/heartbeat`. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Wall-clock budget for the initial MCP handshake against the sidecar. Wraps
 * both the connect retry loop and the final attempt. See issue #406.
 */
export const MCP_CONNECT_DEADLINE_MS = 60_000;
// Read from core rather than mirrored here. The mirror was guarded by
// `satisfies readonly ModelApiShape[]`, which cannot prove COMPLETENESS — a
// shape added to core and emitted by the platform typechecked green and then
// threw `MODEL_API: unknown api` at every container boot.
const KNOWN_MODEL_APIS = new Set<string>(MODEL_API_SHAPES);

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
    issues.push(`${name}: malformed JSON — ${getErrorMessage(err)}`);
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
    issues.push(`MODEL_INPUT: malformed JSON — ${getErrorMessage(err)}`);
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

function parseReasoningLevelMap(
  raw: string | undefined,
  issues: string[],
): Partial<Record<ModelReasoningLevel, ModelNativeReasoningLevel>> | undefined {
  if (!raw) return undefined;
  const parsed = parseJsonRecord("MODEL_REASONING_LEVEL_MAP", raw, issues);
  const out: Partial<Record<ModelReasoningLevel, ModelNativeReasoningLevel>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const portable = modelReasoningLevelSchema.safeParse(key);
    const native = modelNativeReasoningLevelSchema.safeParse(value);
    if (!portable.success || !native.success) {
      issues.push(`MODEL_REASONING_LEVEL_MAP: invalid mapping "${key}" → "${String(value)}"`);
      continue;
    }
    out[portable.data] = native.data;
  }
  return out;
}

function parseModelCost(
  raw: string | undefined,
  issues: string[],
  warnings: string[],
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const fallback = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!raw) {
    // The platform sets MODEL_COST only when the resolved model carries rates
    // AND the run may see them (`buildRuntimePiEnv` withholds the card from an
    // aliased model — the published rate card names the vendor the alias
    // exists to hide). Either way, no rates reached this container.
    //
    // Returning `undefined` rather than the all-zero shape is the point. Zero
    // rates are arithmetically fine and epistemically wrong: they make the run
    // report `cost: 0`, indistinguishable from a genuinely free model, and on
    // an aliased run they would sit next to a real server-computed number and
    // trip the ledger's cost-divergence warning on every single run. Reporting
    // nothing is the honest statement, and the platform already reads it that
    // way — a null reported cost prices the row from `runs.model_cost` and
    // makes no comparison.
    //
    // Still a warning, not an issue: a pricing gap must not become an outage.
    // (Server-side the same run's ledger row is stamped
    // `pricing_status='unpriced'` from `runs.model_cost`; this line is the
    // in-container half of the same fact, for operators reading logs.)
    warnings.push(
      "MODEL_COST: absent — no per-token pricing reached this container; " +
        "this run reports no cost of its own (the platform prices it server-side)",
    );
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push(`MODEL_COST: malformed JSON — ${getErrorMessage(err)}`);
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

function parsePositiveNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  issues: string[],
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    issues.push(`${name}: must be a positive finite number (got "${raw}")`);
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
  // Non-fatal siblings of `issues` — collected the same way, surfaced by the
  // caller as `warn` log lines instead of a throw. See {@link RuntimeEnv.warnings}.
  const warnings: string[] = [];

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
  const modelCost = parseModelCost(source.MODEL_COST, issues, warnings);
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
  const modelTemperature =
    source.MODEL_TEMPERATURE === undefined ? undefined : Number(source.MODEL_TEMPERATURE);
  if (
    modelTemperature !== undefined &&
    (!Number.isFinite(modelTemperature) || modelTemperature < 0 || modelTemperature > 1)
  ) {
    issues.push(
      `MODEL_TEMPERATURE: must be a finite number between 0 and 1 (got "${source.MODEL_TEMPERATURE}")`,
    );
  }
  const modelReasoningLevel =
    source.MODEL_REASONING_LEVEL === undefined
      ? undefined
      : modelReasoningLevelSchema.safeParse(source.MODEL_REASONING_LEVEL);
  if (modelReasoningLevel && !modelReasoningLevel.success) {
    issues.push(
      `MODEL_REASONING_LEVEL: invalid value "${source.MODEL_REASONING_LEVEL}" (allowed: ${modelReasoningLevelSchema.options.join(", ")})`,
    );
  }
  const modelReasoningLevelMap = parseReasoningLevelMap(source.MODEL_REASONING_LEVEL_MAP, issues);
  // Optional: a 0 fallback means "absent" (parsePositiveNumber only returns it
  // for a missing var, or after pushing an issue for a malformed one). We map
  // 0 → undefined so an absent budget leaves runner-side enforcement off.
  const agentTimeoutSeconds = parsePositiveNumber(
    "AGENT_TIMEOUT_SECONDS",
    source.AGENT_TIMEOUT_SECONDS,
    0,
    issues,
  );
  // Optional (#779 annex): per-call MCP tool timeout for the agent→sidecar
  // client. Same 0-means-absent convention as AGENT_TIMEOUT_SECONDS.
  const mcpToolTimeoutMs = parsePositiveInt(
    "APPSTRATE_MCP_TOOL_TIMEOUT_MS",
    source.APPSTRATE_MCP_TOOL_TIMEOUT_MS,
    0,
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
    ...(modelTemperature !== undefined ? { modelTemperature } : {}),
    ...(modelReasoningLevel?.success
      ? { modelReasoningLevel: modelReasoningLevel.data as ModelReasoningLevel }
      : {}),
    ...(modelReasoningLevelMap ? { modelReasoningLevelMap } : {}),
    ...(source.MODEL_PROVIDER ? { modelProvider: source.MODEL_PROVIDER } : {}),
    modelInput,
    ...(modelCost !== undefined ? { modelCost } : {}),
    modelContextWindow,
    modelMaxTokens,
    agentPrompt: agentPrompt!,
    agentInput,
    sink: { url: sinkUrl!, finalizeUrl: sinkFinalizeUrl!, secret: sinkSecret! },
    sidecarUrl: sidecarUrl || undefined,
    timeoutSeconds: agentTimeoutSeconds > 0 ? agentTimeoutSeconds : undefined,
    ...(mcpToolTimeoutMs > 0 ? { mcpToolTimeoutMs } : {}),
    traceparent: source.TRACEPARENT || undefined,
    warnings,
  };
}

/** Sink variables captured into {@link RuntimeEnv.sink} and then scrubbed. */
const SINK_ENV_KEYS = [
  "APPSTRATE_SINK_SECRET",
  "APPSTRATE_SINK_URL",
  "APPSTRATE_SINK_FINALIZE_URL",
] as const;

/**
 * Remove the run's sink credentials from the environment once
 * {@link parseRuntimeEnv} has captured them into {@link RuntimeEnv.sink}.
 *
 * Same zero-knowledge reasoning as the `delete process.env.SIDECAR_URL` in
 * `entrypoint.ts`: the agent loop runs arbitrary model-chosen commands through
 * the Pi bash extension, and the agent's input (an email body, a fetched page,
 * an input file) is attacker-controllable. `env | grep SINK` would hand a
 * prompt-injected agent the HMAC key for its own run, which is enough to forge
 * a `status: "success"` finalize the platform cannot distinguish from the real
 * one, or to POST files straight to `/api/runs/:id/files` past the
 * `runtime_tools` gate up to the per-run cap.
 *
 * Safe: nothing downstream re-reads these from the environment. The sink, the
 * file uploader and the provisioning fetches all take the captured
 * `env.sink` struct.
 */
export function scrubSinkEnv(source: NodeJS.ProcessEnv = process.env): void {
  for (const key of SINK_ENV_KEYS) delete source[key];
}
