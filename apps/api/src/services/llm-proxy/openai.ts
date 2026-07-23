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
 * Cache-token field: two shapes are read (only when `readPromptCacheDetails`
 * is set):
 *   - OpenAI surfaces `prompt_tokens_details.cached_tokens` (2024 prompt
 *     caching), where `cached_tokens ⊂ prompt_tokens`.
 *   - DeepSeek (OpenAI-compatible) surfaces top-level
 *     `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, where
 *     `prompt_tokens = hit + miss`.
 * In BOTH shapes `prompt_tokens` is the TOTAL input (cache reads included), so
 * this adapter subtracts the cache-read count back out of `inputTokens` — see
 * the `UpstreamUsage` doc for the disjoint-bucket cost convention. The
 * DeepSeek-specific top-level field is preferred when both are present.
 * Mistral and the other OpenAI-completions providers (cerebras, groq,
 * openrouter, xai) surface neither — nothing is read for them.
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import { extractUsageObject, numberOrUndefined, parseSseDataFrame } from "./helpers.ts";

interface AdapterOptions {
  /** Protocol family discriminator — must match the route's `apiShape`. */
  apiShape: string;
  /** Inbound header names (lowercase) the adapter forwards to upstream. */
  forwardHeaders?: ReadonlySet<string>;
  /**
   * Read cache-read tokens (OpenAI `prompt_tokens_details.cached_tokens` OR
   * DeepSeek `prompt_cache_hit_tokens`) into `cacheReadTokens`, subtracting
   * them out of `inputTokens` so the two never double-count.
   */
  readPromptCacheDetails?: boolean;
}

/**
 * Cache-read token count from an OpenAI-compatible `usage` object, from either
 * source. DeepSeek's top-level `prompt_cache_hit_tokens` is the more specific
 * signal (a dedicated field, not a nested detail), so it wins when both are
 * present. Returns undefined when neither source carries a number.
 */
function readCacheReadTokens(u: Record<string, unknown>): number | undefined {
  const deepseekHit = numberOrUndefined(u["prompt_cache_hit_tokens"]);
  if (deepseekHit !== undefined) return deepseekHit;
  const details = (u["prompt_tokens_details"] ?? null) as Record<string, unknown> | null;
  if (details && typeof details === "object") {
    return numberOrUndefined(details["cached_tokens"]);
  }
  return undefined;
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
        const cacheRead = readCacheReadTokens(u);
        if (cacheRead !== undefined) {
          result.cacheReadTokens = cacheRead;
          // `prompt_tokens` counts cache hits + misses in both shapes (OpenAI:
          // `cached_tokens ⊂ prompt_tokens`; DeepSeek: `prompt_tokens = hit +
          // miss`). Cost bills `inputTokens` and `cacheReadTokens` as DISJOINT
          // buckets, so the cache reads must be subtracted out of `inputTokens`
          // — otherwise they are charged twice (full input rate + cache-read
          // rate). Clamp at 0 against a malformed upstream where cached >
          // prompt.
          result.inputTokens = Math.max(0, result.inputTokens - cacheRead);
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
