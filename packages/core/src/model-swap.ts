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
 *
 * The exception is {@link scrubModelText}: error bodies are free-form prose
 * ("the model `deepseek-chat` does not exist"), so the real id can sit anywhere.
 * There a blind substring replace is correct — an error body carries no
 * generated content to clobber.
 */

import type { ModelApiShape, ModelSwap } from "./sidecar-types.ts";

/**
 * API shapes that carry the model id in the REQUEST BODY (top-level `model`) —
 * the only shapes the swap can rewrite. The remaining shapes (`google-*`,
 * `azure-*`, `bedrock-*`) put the model id in the URL path / deployment segment,
 * which this swap does not touch, so an alias on those would forward `<alias>`
 * verbatim and 404 upstream. Callers MUST reject `aliased` for any shape not in
 * this set (see {@link isAliasableApiShape}).
 */
export const ALIASABLE_API_SHAPES: ReadonlySet<ModelApiShape> = new Set<ModelApiShape>([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
]);

/** True when an alias is technically supportable for this protocol shape. */
export function isAliasableApiShape(shape: ModelApiShape): boolean {
  return ALIASABLE_API_SHAPES.has(shape);
}

/**
 * Reason an aliased model fails its configuration invariants (issue #727,
 * Threat A), or `null` when it is well-formed:
 *   - `missing_label` — no explicit label; the derived label would name the
 *     real backing and leak it on `/api/models` and `run.model_label`.
 *   - `non_aliasable_shape` — the protocol carries the model id in the URL, not
 *     the request body, so the swap can't hide the backing.
 */
export type AliasInvariantViolation = "missing_label" | "non_aliasable_shape";

/**
 * Single source of truth for the model-alias invariants, shared by both trust
 * boundaries that accept an alias: the env-seeded registry (`model-registry`,
 * skips on violation) and the DB `POST /api/models` route (rejects on
 * violation). Each caller maps the returned reason to its own outcome/message.
 */
export function checkAliasInvariants(input: {
  label?: string | null;
  apiShape: ModelApiShape;
}): AliasInvariantViolation | null {
  if (!input.label) return "missing_label";
  if (!isAliasableApiShape(input.apiShape)) return "non_aliasable_shape";
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
 * Blind substring replace of the real id with the alias, for ERROR bodies only.
 * Provider error payloads name the model in free-form prose
 * (`{"error":{"message":"model deepseek-chat is overloaded"}}`), so the exact-
 * field swap misses it. An error body carries no generated content, so a blind
 * replace cannot clobber anything meaningful. No-op when the body doesn't
 * mention the real id (the common case).
 *
 * When `swap.realHost` is set, the backing hostname is masked the same way
 * ("ConnectionRefused (api.deepseek.com)" identifies the provider as surely as
 * the model id) — replaced with a neutral `upstream` marker, since there is no
 * alias hostname to substitute.
 */
export const SCRUBBED_HOST_MARKER = "upstream";

/**
 * Hostname of a base URL, for {@link ModelSwap.realHost}. Returns `undefined`
 * on an unparsable URL — the swap then simply skips host scrubbing.
 */
export function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function scrubModelText(text: string, swap: ModelSwap): string {
  let out = text;
  // Host FIRST: if the real id happens to be a substring of the hostname
  // (possible with operator-configured openai-compatible endpoints), scrubbing
  // the id first would mutate the hostname and make the host pass miss it. A
  // hostname is never a substring of a model id, so this order is always safe.
  if (swap.realHost && out.includes(swap.realHost)) {
    out = out.split(swap.realHost).join(SCRUBBED_HOST_MARKER);
  }
  if (out.includes(swap.real)) out = out.split(swap.real).join(swap.alias);
  return out;
}

/**
 * Response headers forwarded to the caller from an upstream LLM provider.
 * Shared posture for both inference data paths (the in-container sidecar
 * proxy and the platform `/api/llm-proxy/*` gateway on aliased responses):
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
 * True when a parsed SSE frame is an error event — Anthropic emits
 * `{"type":"error","error":{...}}`, OpenAI-family streams emit a standalone
 * top-level `error` object (no `choices` alongside). Error frames carry no
 * generated content, so the blind {@link scrubModelText} prose scrub is safe
 * on them (and required: the real id / hostname sits in free-form
 * `error.message` prose the exact-field rewrite can't reach). The `choices`
 * guard keeps any hybrid frame that also carries content on the exact-field
 * path — generated content must never be blind-scrubbed.
 */
function isSseErrorFrame(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["type"] === "error") return true;
  const error = o["error"];
  return typeof error === "object" && error !== null && !Array.isArray(error) && !("choices" in o);
}

/** Rewrite a single SSE line's `model` real→alias (data lines only). */
function rewriteSseLine(line: string, swap: ModelSwap): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trimStart();
  // Fast skip: the [DONE] sentinel and any chunk that doesn't mention the real
  // id or host (the vast majority — content deltas) need no parse.
  const mentionsBacking =
    payload.includes(swap.real) || (swap.realHost !== undefined && payload.includes(swap.realHost));
  if (payload === "[DONE]" || !mentionsBacking) return line;
  try {
    const obj = JSON.parse(payload);
    rewriteModelRealToAlias(obj, swap);
    const rewritten = JSON.stringify(obj);
    // Mid-stream error frames name the backing in free-form prose — scrub the
    // whole frame. Never blind-replace a non-error frame: generated content
    // mentioning the real id must not be clobbered.
    return `data: ${isSseErrorFrame(obj) ? scrubModelText(rewritten, swap) : rewritten}`;
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
