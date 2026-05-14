// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI-compatible adapters for `/api/llm-proxy/*`.
 *
 * The `openai-completions` and `mistral-conversations` apiShapes speak
 * the same wire (snake_case `prompt_tokens` / `completion_tokens`, SSE
 * usage on the terminal frame). The only protocol-specific differences
 * are which inbound headers get forwarded and whether `prompt_tokens_details`
 * carries cache counts — both expressed here as `AdapterOptions`. Adding
 * a new OpenAI-compatible apiShape is a single call to
 * {@link createOpenAICompatibleAdapter}.
 *
 * Cache-token field: OpenAI surfaces `prompt_tokens_details.cached_tokens`
 * (2024 prompt caching). Mistral and the other OpenAI-completions
 * providers (cerebras, groq, openrouter, xai) do not — they read nothing
 * from `prompt_tokens_details` even if present.
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import { extractUsageObject, numberOrUndefined, parseSseDataFrame } from "./helpers.ts";

interface AdapterOptions {
  /** Protocol family discriminator — must match the route's `apiShape`. */
  apiShape: string;
  /** Inbound header names (lowercase) the adapter forwards to upstream. */
  forwardHeaders?: ReadonlySet<string>;
  /** Read `prompt_tokens_details.cached_tokens` into `cacheReadTokens` (OpenAI prompt caching). */
  readPromptCacheDetails?: boolean;
}

export function createOpenAICompatibleAdapter(opts: AdapterOptions): LlmProxyAdapter {
  const forwardHeaders = opts.forwardHeaders ?? new Set<string>();
  const readCache = opts.readPromptCacheDetails ?? false;

  const adapter: LlmProxyAdapter = {
    apiShape: opts.apiShape,

    buildUpstreamHeaders(incoming, apiKey) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (forwardHeaders.size > 0) {
        for (const [k, v] of incoming) {
          if (forwardHeaders.has(k.toLowerCase())) headers[k] = v;
        }
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
      if (readCache) {
        const details = (u["prompt_tokens_details"] ?? null) as Record<string, unknown> | null;
        if (details && typeof details === "object") {
          const cached = numberOrUndefined(details["cached_tokens"]);
          if (cached !== undefined) result.cacheReadTokens = cached;
        }
      }
      return result;
    },

    parseSseUsage(events) {
      // Iterate newest-to-oldest — OpenAI-compatible providers emit `usage`
      // only on the terminal frame (or not at all when the client didn't
      // opt in via `stream_options.include_usage`).
      for (let i = events.length - 1; i >= 0; i--) {
        const frame = parseSseDataFrame(events[i]!);
        if (!frame) continue;
        const parsed = adapter.parseJsonUsage(frame);
        if (parsed) return parsed;
      }
      return null;
    },
  };

  return adapter;
}

export const openaiCompletionsAdapter = createOpenAICompatibleAdapter({
  apiShape: "openai-completions",
  forwardHeaders: new Set(["openai-organization", "openai-beta"]),
  readPromptCacheDetails: true,
});
