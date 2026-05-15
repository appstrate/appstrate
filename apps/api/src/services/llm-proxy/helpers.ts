// SPDX-License-Identifier: Apache-2.0

/**
 * Shared body-manipulation helpers for `/api/llm-proxy/*` adapters.
 *
 * Every protocol family the proxy supports today (OpenAI Chat
 * Completions, Anthropic Messages, Mistral Chat Completions) speaks JSON
 * with a top-level `model` and a `usage` object, and streams via SSE
 * `data: {…}` frames. The transport-level mechanics — JSON parse,
 * `body.model` rewrite, SSE frame extraction — are identical across
 * adapters. Centralising them here keeps each adapter focused on the
 * truly protocol-specific bits (which fields to read out of `usage`,
 * which headers to forward).
 *
 * Adapter-specific behaviour stays in the adapter:
 *   - which usage fields to read (`prompt_tokens` vs `input_tokens`, …)
 *   - which auth header to inject (`Authorization` vs `x-api-key`)
 *   - which inbound headers to forward (`anthropic-beta`, `openai-beta`, …)
 *
 * The `parseSseDataFrame` helper filters out OpenAI's `[DONE]`
 * terminator. Anthropic never emits that terminator, so the filter is a
 * no-op there — keeping a single shared helper rather than two near-
 * duplicates.
 */

import { invalidRequest } from "../../lib/errors.ts";

/**
 * Parsed shape of an inbound `/api/llm-proxy/*` request body. Built
 * once at the start of the pipeline so the preset extraction, the
 * streaming detection, and the upstream model rewrite all share a
 * single `JSON.parse` over the raw bytes.
 */
export interface ParsedProxyRequest {
  /** Caller-supplied preset id (the value of `body.model`). */
  presetId: string;
  /** True iff `body.stream === true`. */
  stream: boolean;
  /**
   * Produce a fresh body byte sequence with `model` swapped for
   * `upstreamModelId`. The rest of the payload is preserved verbatim.
   */
  rewriteModel(upstreamModelId: string): Uint8Array;
}

/**
 * Parse a `/api/llm-proxy/*` request body once. Throws `invalidRequest`
 * if the payload isn't a JSON object with a non-empty `model` field —
 * the proxy can't route a request without a preset id.
 */
export function parseProxyRequest(rawBody: Uint8Array): ParsedProxyRequest {
  const text = new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidRequest("Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const model = obj["model"];
  if (typeof model !== "string" || model.length === 0) {
    throw invalidRequest("Request body must include a non-empty `model` field");
  }
  return {
    presetId: model,
    stream: obj["stream"] === true,
    rewriteModel(upstreamModelId: string): Uint8Array {
      obj["model"] = upstreamModelId;
      return new TextEncoder().encode(JSON.stringify(obj));
    },
  };
}

/**
 * Cheap, shape-agnostic token estimate for a parsed proxy request body.
 *
 *   estimated = ceil(promptChars / 3.5) + maxTokensOrDefault
 *
 * Where `promptChars` is the byte-budget proxy:
 *   - OpenAI / Mistral chat completions: sum of `messages[].content` strings.
 *     OpenAI's content can also be an array of `{type, text}` parts — those
 *     are summed too.
 *   - Anthropic messages: `system` (string or `{type, text}` array) plus the
 *     same `messages[].content` walk.
 *
 * `maxTokensOrDefault` reads `body.max_tokens`. When unset, we fall back to
 * `defaultMaxTokens` — the limiter's "we don't know how big the response will
 * be, so reserve a reasonable ceiling" sentinel. Keep this synchronous and
 * cheap: this runs on the proxy hot path before every upstream call.
 *
 * The estimate is deliberately approximate. Token throughput limits are a
 * traffic-shaping tool against fan-out fleets, not a billing meter — the
 * canonical metering still happens after the upstream call in `llm_usage`.
 */
export function estimateRequestTokens(rawBody: Uint8Array, defaultMaxTokens: number): number {
  const text = new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return defaultMaxTokens;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaultMaxTokens;
  }
  const body = parsed as Record<string, unknown>;
  const promptChars = countPromptChars(body);
  const maxTokens = numberOrUndefined(body["max_tokens"]) ?? defaultMaxTokens;
  return Math.ceil(promptChars / 3.5) + maxTokens;
}

/** Walk the request body and sum every prompt-bearing character. */
function countPromptChars(body: Record<string, unknown>): number {
  let total = 0;
  total += countContentField(body["system"]);
  const messages = body["messages"];
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      total += countContentField((msg as Record<string, unknown>)["content"]);
    }
  }
  return total;
}

/**
 * Sum the character count of a `content` field. OpenAI allows a string or an
 * array of `{type: "text", text: "..."}` parts (and now image_url / etc.).
 * Anthropic's `system` follows the same dual shape. We only count text;
 * binary parts (images, audio) are not token-bearing in our cheap estimator.
 */
function countContentField(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const part of value) {
    if (typeof part === "string") {
      total += part.length;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const text = (part as Record<string, unknown>)["text"];
    if (typeof text === "string") total += text.length;
  }
  return total;
}

/** Pull `body.usage` out of a parsed JSON response. Returns null if absent or malformed. */
export function extractUsageObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as Record<string, unknown>)["usage"];
  if (!u || typeof u !== "object") return null;
  return u as Record<string, unknown>;
}

/** Coerce an unknown value into a finite number, or undefined. */
export function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Extract the JSON payload of an SSE `data: …` frame. Concatenates
 * multi-line `data:` payloads per RFC, returns null on the OpenAI
 * `[DONE]` terminator or unparseable JSON.
 */
export function parseSseDataFrame(chunk: string): unknown | null {
  const lines = chunk.split("\n");
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  const payload = data.join("");
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
