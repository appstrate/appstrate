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

import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Rewrite `body.model` to `upstreamModelId` without parsing-then-reserialising
 * the whole payload when it isn't shaped like a JSON object. A non-JSON
 * or non-object body is forwarded as-is — the upstream is in a better
 * position to reject it than the proxy is to second-guess it.
 */
export function substituteModelJson(rawBody: Uint8Array, upstreamModelId: string): Uint8Array {
  const text = new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn("llm-proxy: request body is not JSON — forwarding as-is", {
      error: getErrorMessage(err),
    });
    return rawBody;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawBody;
  }
  (parsed as Record<string, unknown>)["model"] = upstreamModelId;
  return new TextEncoder().encode(JSON.stringify(parsed));
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
