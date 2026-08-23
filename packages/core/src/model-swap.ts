// SPDX-License-Identifier: Apache-2.0

/**
 * Model-alias swap (LLM-gateway alias pattern) — the inference-data-path half
 * of issue #727. A public vanity id (`alias`, e.g. `appstrate-medium`) is
 * exposed to callers/agents while the real upstream id (`real`, e.g.
 * `deepseek-chat`) stays server-side. Every request arrives with
 * `model: <alias>`; it is rewritten to `<real>` before forwarding upstream, and
 * the provider's echoed `model: <real>` is rewritten back to `<alias>` on the
 * way out — non-stream JSON AND streaming SSE. The caller therefore only ever
 * sees the alias.
 *
 * This module is the single source of truth for the swap, consumed by BOTH
 * inference data paths:
 *   - the in-container sidecar proxy (`runtime-pi/sidecar`), and
 *   - the platform LLM gateway (`apps/api` `/api/llm-proxy/*`).
 *
 * Matching is by EXACT value at the known JSON locations, never a blind string
 * replace — so a model id that happens to appear inside generated content is
 * never clobbered. Known locations:
 *   - top-level `model` — OpenAI chat-completions (request, chunk, completion),
 *     Anthropic (request, non-stream Message), and the OpenAI Responses API
 *     non-stream body,
 *   - `message.model` — Anthropic streaming `message_start` event,
 *   - `response.model` — OpenAI Responses API streaming events
 *     (`response.created` / `response.completed`, etc. carry a `response`
 *     snapshot). Both `openai-responses` and `openai-codex-responses` (codex)
 *     are aliasable, so this nesting MUST be covered or the real id leaks in
 *     the stream.
 *   - `thinking` / `output_config` — request-only correction for an adaptive
 *     Anthropic backing. Pi sees the public alias, so the sidecar restores the
 *     catalogued adaptive shape from its private swap descriptor.
 *
 * The SURFACE itself is narrowed too: for an aliased run only the protocol's
 * own inference endpoint is a legitimate call, so
 * {@link ALIAS_INFERENCE_PATHS} / {@link isAliasInferenceCall} give the
 * sidecar an allowlist to refuse everything else (a vendor catalogue read like
 * `GET /v1/models` returns 2xx, so neither the error synthesis nor the field
 * rewrite below would have caught it).
 *
 * ERROR surfaces are handled differently: provider error bodies are free-form
 * prose that can name the backing anywhere (model id, hostname, provider
 * vocabulary), so for an aliased model they are never forwarded at all —
 * {@link syntheticAliasErrorBody} REPLACES them with a neutral envelope
 * (whitelist by construction; a scrub would be a blacklist where every
 * forgotten surface is a new leak). Status code + allowlisted headers
 * ({@link LLM_PASSTHROUGH_RESPONSE_HEADERS}) still flow for retry/backoff.
 */

import type { ModelApiShape, ModelSwap } from "./sidecar-types.ts";

/**
 * The ONE upstream inference endpoint each aliasable protocol family calls,
 * as the path suffix its SDK appends to the configured base URL.
 *
 * This table has two readers, and they must not drift:
 *   - the platform LLM gateway (`apps/api` `routes/llm-proxy.ts`) uses it as
 *     the `upstreamPath` it joins onto the model's stored `baseUrl`, and
 *   - the in-container sidecar uses it via {@link isAliasInferenceCall} to
 *     decide whether an inbound `/llm/*` request is the inference call at all.
 * The sidecar sees exactly the same suffix: the container's `MODEL_BASE_URL`
 * is `<sidecar>/llm`, and `deriveLlmTarget` strips that `/llm` mount prefix
 * before recomposing the upstream URL.
 *
 * Each value is the SDK's own literal, not a guess:
 *   - `anthropic-messages`     — `@anthropic-ai/sdk` posts `/v1/messages`.
 *   - `openai-completions`     — `openai` posts `/chat/completions` (the `/v1`
 *     lives in the base URL: `https://api.openai.com/v1`).
 *   - `openai-responses`       — `openai` posts `/responses`, same convention.
 *   - `openai-codex-responses` — pi-ai builds the URL itself
 *     (`resolveCodexUrl`) and appends `/codex/responses`.
 *   - `mistral-conversations`  — pi-ai resolves `v1/chat/completions` against
 *     the base URL (slash-terminated first, so the prefix survives).
 *
 * A shape absent from this table is one the alias swap cannot serve at all —
 * `google-*`, `azure-*` and `bedrock-*` carry the model id in the URL path /
 * deployment segment rather than the request body, so the swap could not
 * rewrite them and an alias on those would forward `<alias>` verbatim and 404
 * upstream. That is why the aliasable set below is DERIVED from these keys
 * rather than restated: one list, no mirror to police.
 */
export const ALIAS_INFERENCE_PATHS = {
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "openai-codex-responses": "/codex/responses",
  "mistral-conversations": "/v1/chat/completions",
} as const satisfies Partial<Record<ModelApiShape, string>>;

/**
 * Widened view of the table for a lookup keyed by ANY shape. Plain assignment
 * to the wider type (no cast): a shape with no entry reads `undefined`, which
 * is what makes {@link isAliasInferenceCall} fail closed.
 */
const INFERENCE_PATH_BY_SHAPE: Readonly<Partial<Record<ModelApiShape, string>>> =
  ALIAS_INFERENCE_PATHS;

/**
 * API shapes that carry the model id in the REQUEST BODY (top-level `model`) —
 * the only shapes the swap can rewrite. Callers MUST reject `aliased` for any
 * shape not in this set (see {@link isAliasableApiShape}).
 *
 * Derived from {@link ALIAS_INFERENCE_PATHS}: "the swap can rewrite it" and
 * "we know the one endpoint it calls" are the same fact, and a hand-mirrored
 * second list would let the two disagree silently.
 */
export const ALIASABLE_API_SHAPES: ReadonlySet<ModelApiShape> = new Set<ModelApiShape>(
  // `satisfies Partial<Record<ModelApiShape, string>>` above already proves
  // every key is a `ModelApiShape`; `Object.keys` just loses that in its
  // `string[]` return type.
  Object.keys(ALIAS_INFERENCE_PATHS) as ModelApiShape[],
);

/** True when an alias is technically supportable for this protocol shape. */
export function isAliasableApiShape(shape: ModelApiShape): boolean {
  return ALIASABLE_API_SHAPES.has(shape);
}

/**
 * True when `(method, path)` is exactly the inference call `shape` needs —
 * the allowlist the sidecar narrows an ALIASED run's `/llm/*` surface down to
 * (issue #1198, Threat B).
 *
 * Without this, `/llm/*` is a total passthrough: an adversarial agent inside
 * the container can `GET <MODEL_BASE_URL>/v1/models` and read the vendor's own
 * catalogue — vendor identity plus the real backing id — in a 2xx body that
 * neither the error synthesis (non-2xx only) nor `swapResponseModelJson`
 * (exact `model` / `message.model` / `response.model` fields only) touches.
 * An alias's contract is that the backing stays hidden, and inference is the
 * only thing the run legitimately needs, so everything else is refused.
 *
 * Fail-closed on both axes: an unknown/url-model shape has no entry, and the
 * comparison is exact — no trailing-slash or case normalisation, because the
 * SDK emits a fixed literal and a normaliser would be one more parser to get
 * wrong at a security boundary. Method is upper-cased only because HTTP does
 * not guarantee the casing the client sent.
 */
export function isAliasInferenceCall(shape: ModelApiShape, method: string, path: string): boolean {
  const inferencePath = INFERENCE_PATH_BY_SHAPE[shape];
  return inferencePath !== undefined && method.toUpperCase() === "POST" && path === inferencePath;
}

/**
 * Reason an aliased model fails its configuration invariants (issue #727,
 * Threat A), or `null` when it is well-formed:
 *   - `missing_label` — no explicit label; the derived label would name the
 *     real backing and leak it on `/api/models` and `run.model_label`.
 *   - `non_aliasable_shape` — the protocol carries the model id in the URL, not
 *     the request body, so the swap can't hide the backing.
 *   - `oauth_provider` — the backing credential is an oauth-subscription
 *     provider. The sidecar's oauth `/llm` mode is a pure bearer-swap (no body
 *     rewrite, `LlmProxyOauthConfig` carries no `modelSwap`), so an alias there
 *     could never be swapped — reject at configuration time.
 */
export type AliasInvariantViolation = "missing_label" | "non_aliasable_shape" | "oauth_provider";

/**
 * Single source of truth for the model-alias invariants, shared by both trust
 * boundaries that accept an alias: the env-seeded registry (`model-registry`,
 * skips on violation) and the DB `POST /api/models` route (rejects on
 * violation). Each caller maps the returned reason to its own outcome/message.
 */
export function checkAliasInvariants(input: {
  label?: string | null;
  apiShape: ModelApiShape;
  /** Auth mode of the backing credential's provider. */
  authMode: "api_key" | "oauth2";
}): AliasInvariantViolation | null {
  if (!input.label) return "missing_label";
  if (!isAliasableApiShape(input.apiShape)) return "non_aliasable_shape";
  if (input.authMode === "oauth2") return "oauth_provider";
  return null;
}

/**
 * Rewrite the request body's top-level `model` alias→real. Returns the input
 * unchanged when it isn't JSON or the field isn't the alias (defensive: a
 * mismatch means the caller sent something unexpected — forward it verbatim
 * rather than corrupt the body).
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
  // top-level `model` — OpenAI chat-completions chunk/completion, Anthropic
  // non-stream Message, OpenAI Responses non-stream body.
  if (o["model"] === swap.real) o["model"] = swap.alias;
  // `message.model` — Anthropic streaming `message_start`.
  // `response.model` — OpenAI Responses streaming `response.*` events carry a
  // `response` snapshot. Both are one-level nestings holding the model id.
  for (const key of ["message", "response"] as const) {
    const nested = o[key];
    if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      if (n["model"] === swap.real) n["model"] = swap.alias;
    }
  }
}

/**
 * Rewrite a non-stream JSON response body's `model` real→alias. Returns the
 * input unchanged on parse failure.
 */
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
 * Response headers forwarded to the caller from an upstream LLM provider.
 * Shared posture for both inference data paths (the in-container sidecar
 * proxy on every response, and the platform `/api/llm-proxy/*` gateway on
 * aliased responses):
 *
 *   - `content-type` — required to parse the body
 *   - `retry-after`, `RateLimit*` — required for backoff on 429
 *   - `x-request-id` — provider-side error correlation
 *
 * Everything else (`server: cloudflare`, `cf-ray`, `anthropic-*`,
 * `openai-organization`, Set-Cookie, hop-by-hop) is dropped — those headers
 * fingerprint the backing provider and/or carry credentials.
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

/**
 * Neutral message used in every synthesized error surface for an aliased
 * model. Deliberately provider-agnostic: an alias's contract is that the
 * caller never learns the backing, so error surfaces are SYNTHESIZED
 * (whitelist by construction), never forwarded-and-scrubbed (blacklist —
 * every forgotten field is a new leak). The upstream detail stays in server
 * logs.
 */
const ALIAS_UPSTREAM_ERROR_MESSAGE = "Upstream model error";

/**
 * Caller-facing body replacing a non-2xx upstream response on an ALIASED
 * model. Nothing from the upstream body survives, so the backing (model id,
 * hostname, provider error vocabulary) cannot leak regardless of what the
 * provider wrote. The status code and the allowlisted headers
 * ({@link LLM_PASSTHROUGH_RESPONSE_HEADERS} — `retry-after`, RateLimit
 * family) still flow, so caller retry/backoff behavior is preserved.
 *
 * The envelope carries BOTH family discriminators — top-level
 * `type: "error"` (Anthropic) and `error.message` (OpenAI family) — so a
 * single shape parses in either SDK regardless of the aliased protocol.
 */
export function syntheticAliasErrorBody(swap: ModelSwap, status?: number): string {
  const statusHint = status ? `, status ${status}` : "";
  return JSON.stringify({
    type: "error",
    error: {
      type: "upstream_error",
      message: `${ALIAS_UPSTREAM_ERROR_MESSAGE} (model "${swap.alias}"${statusHint})`,
    },
  });
}

/** Non-null, non-array object — the only shape an error payload can take. */
function isErrorObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a parsed SSE frame is an error event:
 *   - Anthropic: `{"type":"error","error":{...}}`,
 *   - OpenAI-family: a standalone top-level `error` object (no `choices`
 *     alongside — the `choices` guard keeps any hybrid frame that also
 *     carries generated content on the exact-field path; content is never
 *     replaced),
 *   - OpenAI Responses terminal failures: `response.failed` /
 *     `response.incomplete` nest it as `{"response":{"error":{...}}}` (a
 *     successful snapshot carries `error: null`, which doesn't match).
 */
function isSseErrorFrame(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["type"] === "error") return true;
  if (isErrorObject(o["error"]) && !("choices" in o)) return true;
  const response = o["response"];
  return isErrorObject(response) && isErrorObject((response as Record<string, unknown>)["error"]);
}

/** Rewrite a single SSE line's `model` real→alias (data lines only). */
function rewriteSseLine(line: string, swap: ModelSwap): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trimStart();
  // Fast skip: the [DONE] sentinel and any chunk that mentions neither the
  // real id nor an `"error"` key candidate (the vast majority — content
  // deltas) need no parse. The `"error"` probe stays a plain substring check:
  // a false positive just costs one parse, never a wrong rewrite.
  if (payload === "[DONE]" || (!payload.includes(swap.real) && !payload.includes(`"error"`))) {
    return line;
  }
  try {
    const obj = JSON.parse(payload);
    // Mid-stream error frames carry free-form prose that can name the backing
    // (real id, hostname). Same posture as {@link syntheticAliasErrorBody}:
    // REPLACE the frame wholesale, never forward-and-scrub. Error frames carry
    // no generated content, so nothing meaningful is lost by the caller.
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
 * Streaming (SSE) response transform: rewrite `model` real→alias in each
 * `data:` JSON frame. Line-buffered so a frame split across chunk boundaries is
 * still rewritten correctly (and multi-byte UTF-8 split across chunks is handled
 * by the streaming TextDecoder).
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
      // `ready` ends in "\n", so split's final element is "" — rewriteSseLine
      // returns it untouched ("".startsWith("data:") is false), so a plain map
      // is correct and needs no trailing-element guard.
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
