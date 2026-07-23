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

import { parseSseFrames, parseSseJsonData } from "@appstrate/core/sse";
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
   * `upstreamModelId`. When `includeStreamUsage` is set, a streaming
   * OpenAI-compatible request is also forced to ask for the terminal usage
   * frame. The rest of the payload is preserved.
   */
  rewriteModel(upstreamModelId: string, opts?: { includeStreamUsage?: boolean }): Uint8Array;
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
    rewriteModel(upstreamModelId: string, opts?: { includeStreamUsage?: boolean }): Uint8Array {
      obj["model"] = upstreamModelId;
      if (opts?.includeStreamUsage && obj["stream"] === true) {
        const current = obj["stream_options"];
        obj["stream_options"] =
          current && typeof current === "object" && !Array.isArray(current)
            ? { ...(current as Record<string, unknown>), include_usage: true }
            : { include_usage: true };
      }
      return new TextEncoder().encode(JSON.stringify(obj));
    },
  };
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
 * Extract the JSON payload of an SSE `data: …` frame block (one frame,
 * already split on the blank-line delimiter). Returns null on the OpenAI
 * `[DONE]` terminator or unparseable JSON. Thin wrapper over the shared
 * `@appstrate/core/sse` primitives.
 */
export function parseSseDataFrame(chunk: string): unknown | null {
  const { frames } = parseSseFrames(chunk + "\n\n", "");
  const frame = frames[0];
  return frame ? parseSseJsonData(frame.data) : null;
}
