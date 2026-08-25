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
 * The protocols an alias can be BACKED by. Only these carry the model id in the
 * request BODY; url-model shapes cannot back an alias.
 */
const ALIAS_BACKING_SHAPES = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
] as const satisfies readonly ModelApiShape[];

/** A protocol an alias can be BACKED by — never one a client speaks. */
export type AliasBackingApiShape = (typeof ALIAS_BACKING_SHAPES)[number];

export function isAliasBackingShape(shape: ModelApiShape): shape is AliasBackingApiShape {
  return (ALIAS_BACKING_SHAPES as readonly ModelApiShape[]).includes(shape);
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

// Sidecar boot pins `clientApiShape` to the client dialect, so one path is exact.
const ALIAS_INFERENCE_PATH = "/messages";

/**
 * True when `(method, path)` is exactly the inference call an aliased client
 * makes — the allowlist that narrows an ALIASED run's `/llm/*` surface. Without
 * it, `GET <MODEL_BASE_URL>/v1/models` returns the vendor catalogue in a 2xx body
 * that neither the error synthesis nor the field rewrite touches. Fails closed:
 * the path is matched whole, never by prefix.
 */
export function isAliasInferenceCall(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && path === ALIAS_INFERENCE_PATH;
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
 * The only upstream statuses an aliased response may carry, and the collapse
 * target for the rest.
 *
 * The set balances TWO axes, and getting either wrong is a real defect:
 *
 * 1. VENDOR IDENTITY — the axis the set was originally drawn on. A status
 *    describes the TRANSACTION, not the backing: every candidate vendor answers
 *    429 when throttled and 400 on a bad request, so forwarding one costs no
 *    opacity. That fails for exactly two families — `529` is Anthropic's own
 *    overload code and `520`–`526` say the backing sits behind Cloudflare —
 *    which name a vendor as surely as its prose does. Those are collapsed.
 *
 * 2. RETRYABILITY — the axis the first draft missed. The collapse target is
 *    {@link ALIAS_COLLAPSED_UPSTREAM_STATUS} = 502, and pi-ai's
 *    `RETRYABLE_PROVIDER_ERROR_PATTERN` matches the literal `"502"`. So
 *    collapsing does not merely make a status opaque, it makes it RETRYABLE.
 *    That is harmless for the two vendor families above (both are transient
 *    anyway) and wrong for a terminal 4xx: `413` (request too large — what
 *    Anthropic/Vertex/Bedrock answer to an oversized prompt) and `402`
 *    (OpenRouter on exhausted credits) were terminal and became requests
 *    retried to exhaustion that can never succeed. `402` loses more still:
 *    pi-ai's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` keys on the word
 *    "billing", which this boundary has already replaced with
 *    "Upstream model error", so the status is the only actionable signal left.
 *
 * `402`, `405`, `413`, `415`, `422` and `431` fingerprint no vendor — every
 * candidate answers them alike — so both axes point the same way and they are
 * forwarded.
 *
 * The set is deliberately an allowlist: an unenumerable space of vendor- and
 * CDN-specific codes cannot be subtracted from safely, and a new one appearing
 * upstream must default to opaque rather than to disclosed. When adding one,
 * check it against BOTH axes.
 */
const FORWARDABLE_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 405, 408, 409, 413, 415, 422, 429, 431, 500, 502, 503, 504,
]);

/** Collapse target: a generic "the upstream hop failed" with no vendor in it. */
export const ALIAS_COLLAPSED_UPSTREAM_STATUS = 502;

/**
 * Project an upstream status onto the aliased surface. Both boundaries that
 * replace an upstream failure — the sidecar's re-originated `pi-messages`
 * error event and the platform gateway's synthesized response — MUST call this
 * before disclosing a status, or the code itself fingerprints the vendor that
 * the body was scrubbed to hide.
 */
export function projectAliasUpstreamStatus(status: number): number {
  return FORWARDABLE_UPSTREAM_STATUSES.has(status) ? status : ALIAS_COLLAPSED_UPSTREAM_STATUS;
}

/**
 * Neutral prose with no protocol envelope: a `pi-messages` `error` event needs a
 * bare string where {@link syntheticAliasErrorBody} needs an HTTP body. pi-ai's own
 * error messages interpolate the provider, so none of them may be forwarded.
 *
 * **Pass `status` wherever one is known.** It looks like decoration and is not:
 * this string is the ONLY channel a caller has left to classify the failure,
 * because the body it replaced is gone. pi-ai's `isRetryableAssistantError`
 * (the gate the agent container's retry budget sits behind) is a regex over
 * exactly this text, and its retryable set is largely the transient status
 * literals — `429`, `500`, `502`, `503`, `504`. Omit the status and every
 * aliased failure reads as permanent, so a `429` that the same model on a BYOK
 * credential rides out fails the run instead.
 *
 * Disclosing the integer costs no opacity, which is why the tension resolves
 * this way rather than by loosening the prose: a status describes the
 * TRANSACTION, not the backing. All fourteen candidate vendors answer 429 when
 * throttled and 400 on a bad request, so the number partitions failures by kind
 * and never by vendor — and `MODEL_ALIASES.md` already publishes status codes
 * as part of an alias's contract. What stays replaced is the vendor's prose:
 * model ids, hostnames, provider vocabulary, rate-limit copy.
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
