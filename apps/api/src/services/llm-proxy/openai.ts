// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI-completions adapter for `/api/llm-proxy/openai-completions/*`.
 *
 * Protocol specifics:
 *   - Auth: `Authorization: Bearer <key>`
 *   - Non-streaming usage: `body.usage.{prompt_tokens,completion_tokens,…}`
 *   - Streaming usage: last `data: {…}` chunk whose `usage` field is
 *     populated (requires `stream_options.include_usage: true` from the
 *     client; OpenRouter, Groq, and upstream OpenAI all honour that).
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import { logger } from "../../lib/logger.ts";

/** Forwarded untouched. We never manipulate cache-control / prompt caching hints. */
const HEADERS_TO_FORWARD = new Set(["openai-organization", "openai-beta"]);

export const openaiCompletionsAdapter: LlmProxyAdapter = {
  api: "openai-completions",

  substituteModel(rawBody, realModelId) {
    return substituteModelJson(rawBody, realModelId);
  },

  buildUpstreamHeaders(incoming, upstreamApiKey) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${upstreamApiKey}`,
      "Content-Type": "application/json",
    };
    for (const [k, v] of incoming) {
      if (HEADERS_TO_FORWARD.has(k.toLowerCase())) headers[k] = v;
    }
    return headers;
  },

  parseJsonUsage(body) {
    const u = extractUsageObject(body);
    if (!u) return null;
    const input = numberOrUndefined(u["prompt_tokens"]);
    const output = numberOrUndefined(u["completion_tokens"]);
    if (input === undefined && output === undefined) return null;
    const result: UpstreamUsage = {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
    };
    // `prompt_tokens_details.cached_tokens` — OpenAI prompt caching (2024).
    const details = (u["prompt_tokens_details"] ?? null) as Record<string, unknown> | null;
    if (details && typeof details === "object") {
      const cached = numberOrUndefined(details["cached_tokens"]);
      if (cached !== undefined) result.cacheReadTokens = cached;
    }
    return result;
  },

  parseSseUsage(events) {
    // Iterate newest-to-oldest — OpenAI emits `usage` only on the
    // terminal frame (or not at all when the client didn't opt in).
    for (let i = events.length - 1; i >= 0; i--) {
      const frame = parseSseDataFrame(events[i]!);
      if (!frame) continue;
      const parsed = openaiCompletionsAdapter.parseJsonUsage(frame);
      if (parsed) return parsed;
    }
    return null;
  },
};

/**
 * Rewrite `body.model` in-place without parsing + re-serialising the
 * whole payload when possible. Falls back to full re-serialise if the
 * body isn't a JSON object the regex can target — safer than silently
 * forwarding the wrong model.
 */
function substituteModelJson(rawBody: Uint8Array, realModelId: string): Uint8Array {
  const text = new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn("llm-proxy: request body is not JSON — forwarding as-is", {
      error: err instanceof Error ? err.message : String(err),
    });
    return rawBody;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawBody;
  }
  (parsed as Record<string, unknown>)["model"] = realModelId;
  return new TextEncoder().encode(JSON.stringify(parsed));
}

function extractUsageObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as Record<string, unknown>)["usage"];
  if (!u || typeof u !== "object") return null;
  return u as Record<string, unknown>;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseSseDataFrame(chunk: string): unknown | null {
  // SSE frames separated by blank lines; each frame's `data: …` lines
  // are concatenated per RFC. We only need the payload on each line
  // prefixed with `data:`.
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
