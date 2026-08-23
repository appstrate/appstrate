// SPDX-License-Identifier: Apache-2.0

/**
 * Model-alias swap: callers see a vanity id (`alias`); the real upstream id
 * (`real`) stays server-side. Requests are rewritten alias→real and responses
 * real→alias, in JSON and in SSE, by both the sidecar proxy (`runtime-pi/sidecar`)
 * and the platform gateway (`apps/api`, `/api/llm-proxy/*`). Matching is by exact
 * value at known JSON locations, never a blind replace.
 */

import type { ModelApiShape, ModelSwap } from "./sidecar-types.ts";

/**
 * The upstream inference endpoint each protocol an alias can be BACKED by calls,
 * as the path suffix its SDK appends to the base URL. Only these shapes carry the
 * model id in the request BODY; url-model shapes cannot back an alias.
 */
export const ALIAS_BACKING_INFERENCE_PATHS = {
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "openai-codex-responses": "/codex/responses",
  "mistral-conversations": "/v1/chat/completions",
} as const satisfies Partial<Record<ModelApiShape, string>>;

/** A protocol an alias can be BACKED by — never one a client speaks. */
export type AliasBackingApiShape = keyof typeof ALIAS_BACKING_INFERENCE_PATHS;

export const ALIAS_BACKING_SHAPES: ReadonlySet<ModelApiShape> = new Set<ModelApiShape>(
  Object.keys(ALIAS_BACKING_INFERENCE_PATHS) as AliasBackingApiShape[],
);

export function isAliasBackingShape(shape: ModelApiShape): shape is AliasBackingApiShape {
  return ALIAS_BACKING_SHAPES.has(shape);
}

/**
 * The protocol an ALIASED run's container speaks — pi-ai's vendor-neutral
 * `pi-messages`. `buildRuntimePiEnv` emits it as `MODEL_API` and the launcher
 * stamps it on `ModelSwap.clientApiShape`; split the two and the sidecar's inbound
 * allowlist refuses every call the container makes.
 */
export const ALIAS_CLIENT_API_SHAPE: ModelApiShape = "pi-messages";

export function isAliasClientShape(shape: ModelApiShape): boolean {
  return shape === ALIAS_CLIENT_API_SHAPE;
}

/**
 * Inference path keyed by the CLIENT's protocol — the backings plus `pi-messages`,
 * composed from {@link ALIAS_BACKING_INFERENCE_PATHS} so the two cannot drift.
 */
export const ALIAS_INFERENCE_PATHS = {
  ...ALIAS_BACKING_INFERENCE_PATHS,
  "pi-messages": "/messages",
} as const satisfies Partial<Record<ModelApiShape, string>>;

// Widened view for a lookup keyed by ANY shape. Plain assignment, no cast: an
// unlisted shape reads `undefined`, which is what makes the check fail closed.
const INFERENCE_PATH_BY_SHAPE: Readonly<Partial<Record<ModelApiShape, string>>> =
  ALIAS_INFERENCE_PATHS;

/**
 * True when `(method, path)` is exactly the inference call this alias's CLIENT
 * makes — the allowlist that narrows an ALIASED run's `/llm/*` surface. Without
 * it, `GET <MODEL_BASE_URL>/v1/models` returns the vendor catalogue in a 2xx body
 * that neither the error synthesis nor the field rewrite touches. Keys on
 * `clientApiShape`, never `backingApiShape`, and fails closed on an exact match.
 */
export function isAliasInferenceCall(swap: ModelSwap, method: string, path: string): boolean {
  const inferencePath = INFERENCE_PATH_BY_SHAPE[swap.clientApiShape];
  return inferencePath !== undefined && method.toUpperCase() === "POST" && path === inferencePath;
}

/**
 * Reason an aliased model fails its configuration invariants, or `null`:
 *   - `missing_label` — a derived label names the real backing, leaking it on
 *     `/api/models` and `run.model_label`.
 *   - `non_aliasable_shape` — model id in the URL, or the client-only dialect.
 *   - `oauth_provider` — the oauth `/llm` mode is a pure bearer-swap carrying no
 *     `modelSwap`, so an alias there could never be swapped.
 */
export type AliasInvariantViolation = "missing_label" | "non_aliasable_shape" | "oauth_provider";

/**
 * The alias invariants, shared by the two boundaries that accept one: the
 * env-seeded registry (skips on violation) and `POST /api/models` (rejects).
 */
export function checkAliasInvariants(input: {
  label?: string | null;
  apiShape: ModelApiShape;
  authMode: "api_key" | "oauth2";
}): AliasInvariantViolation | null {
  if (!input.label) return "missing_label";
  if (!isAliasBackingShape(input.apiShape)) return "non_aliasable_shape";
  if (input.authMode === "oauth2") return "oauth_provider";
  return null;
}

/**
 * Rewrite the request body's top-level `model` alias→real, and restore the
 * adaptive `thinking` / `output_config` shape an Anthropic backing expects.
 * A body that isn't JSON, or whose `model` isn't the alias, is left verbatim.
 */
export function swapRequestModel(bodyText: string, swap: ModelSwap): string {
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    if (obj && typeof obj === "object" && obj["model"] === swap.alias) {
      obj["model"] = swap.real;
      const thinking = obj["thinking"];
      if (
        swap.anthropicAdaptiveReasoning &&
        thinking &&
        typeof thinking === "object" &&
        (thinking as Record<string, unknown>)["type"] === "enabled"
      ) {
        const display = (thinking as Record<string, unknown>)["display"];
        obj["thinking"] = {
          type: "adaptive",
          ...(typeof display === "string" ? { display } : {}),
        };
        const outputConfig = obj["output_config"];
        obj["output_config"] = {
          ...(outputConfig && typeof outputConfig === "object" ? outputConfig : {}),
          effort: swap.anthropicAdaptiveReasoning.effort,
        };
      }
      return JSON.stringify(obj);
    }
  } catch {
    // Not JSON — pass through untouched.
  }
  return bodyText;
}

/** Rewrite the known `model` locations real→alias in a parsed object (mutates). */
function rewriteModelRealToAlias(obj: unknown, swap: ModelSwap): void {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  if (o["model"] === swap.real) o["model"] = swap.alias;
  // `message` (Anthropic `message_start`) and `response` (OpenAI Responses
  // events) are one-level nestings that also hold the model id.
  for (const key of ["message", "response"] as const) {
    const nested = o[key];
    if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      if (n["model"] === swap.real) n["model"] = swap.alias;
    }
  }
}

export function swapResponseModelJson(bodyText: string, swap: ModelSwap): string {
  try {
    const obj = JSON.parse(bodyText);
    rewriteModelRealToAlias(obj, swap);
    return JSON.stringify(obj);
  } catch {
    return bodyText;
  }
}

/**
 * The only response headers forwarded from an upstream LLM provider: content type,
 * `retry-after` / `RateLimit*`, `x-request-id`. The rest fingerprint the backing.
 */
export const LLM_PASSTHROUGH_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "x-request-id",
];

/** Neutral prose for every synthesized alias error; upstream detail stays in the log. */
const ALIAS_UPSTREAM_ERROR_MESSAGE = "Upstream model error";

/**
 * Neutral prose with no protocol envelope: a `pi-messages` `error` event needs a
 * bare string where {@link syntheticAliasErrorBody} needs an HTTP body. pi-ai's own
 * error messages interpolate the provider, so none of them may be forwarded.
 */
export function syntheticAliasErrorMessage(swap: ModelSwap, status?: number): string {
  const statusHint = status ? `, status ${status}` : "";
  return `${ALIAS_UPSTREAM_ERROR_MESSAGE} (model "${swap.alias}"${statusHint})`;
}

/**
 * Caller-facing body replacing a non-2xx upstream response on an ALIASED model:
 * nothing from upstream survives, only the status code and
 * {@link LLM_PASSTHROUGH_RESPONSE_HEADERS}. Carries both family discriminators
 * (`type: "error"` and `error.message`) so one shape parses in either SDK.
 */
export function syntheticAliasErrorBody(swap: ModelSwap, status?: number): string {
  return JSON.stringify({
    type: "error",
    error: {
      type: "upstream_error",
      message: syntheticAliasErrorMessage(swap, status),
    },
  });
}

function isErrorObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// An error frame is Anthropic's `{"type":"error"}`, an OpenAI-family top-level
// `error` object, or the OpenAI Responses nesting `{"response":{"error":{…}}}`.
// The `choices` guard keeps a hybrid frame that also carries generated content on
// the exact-field path, so content is never replaced.
function isSseErrorFrame(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["type"] === "error") return true;
  if (isErrorObject(o["error"]) && !("choices" in o)) return true;
  const response = o["response"];
  return isErrorObject(response) && isErrorObject((response as Record<string, unknown>)["error"]);
}

function rewriteSseLine(line: string, swap: ModelSwap): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trimStart();
  // Fast skip: [DONE] and chunks naming neither the real id nor `"error"` need no
  // parse. A false positive on the probe costs a parse, never a wrong rewrite.
  if (payload === "[DONE]" || (!payload.includes(swap.real) && !payload.includes(`"error"`))) {
    return line;
  }
  try {
    const obj = JSON.parse(payload);
    // Error frames name the backing in free-form prose, so they are replaced
    // wholesale; they carry no generated content, so the caller loses nothing.
    if (isSseErrorFrame(obj)) {
      return `data: ${syntheticAliasErrorBody(swap)}`;
    }
    rewriteModelRealToAlias(obj, swap);
    return `data: ${JSON.stringify(obj)}`;
  } catch {
    return line;
  }
}

/**
 * Streaming (SSE) transform: rewrite `model` real→alias in each `data:` frame.
 * Line-buffered so a frame split across chunk boundaries is still rewritten.
 */
export function createSseModelSwapStream(swap: ModelSwap): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const newlineEnd = buffer.lastIndexOf("\n");
      if (newlineEnd === -1) return; // no complete line yet — keep buffering
      const ready = buffer.slice(0, newlineEnd + 1);
      buffer = buffer.slice(newlineEnd + 1);
      // `ready` ends in "\n", so split's last element is "" and rewriteSseLine
      // returns it untouched — hence no trailing-element guard.
      const rewritten = ready
        .split("\n")
        .map((line) => rewriteSseLine(line, swap))
        .join("\n");
      controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewriteSseLine(buffer, swap)));
    },
  });
}
