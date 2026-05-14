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
import { extractUsageObject, numberOrUndefined, parseSseDataFrame } from "./helpers.ts";

/** Forwarded untouched. We never manipulate cache-control / prompt caching hints. */
const HEADERS_TO_FORWARD = new Set(["openai-organization", "openai-beta"]);

export const openaiCompletionsAdapter: LlmProxyAdapter = {
  apiShape: "openai-completions",

  buildUpstreamHeaders(incoming, apiKey) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
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
