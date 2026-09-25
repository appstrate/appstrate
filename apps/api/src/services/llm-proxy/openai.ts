// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI-compatible adapters for `/api/llm-proxy/*`.
 *
 * The `openai-completions` and `mistral-conversations` apiShapes speak
 * the same wire (snake_case `prompt_tokens` / `completion_tokens`, SSE
 * usage on the terminal frame) and the same bearer auth. Adding a new
 * OpenAI-compatible apiShape is a single call to
 * {@link createOpenAICompatibleAdapter}.
 *
 * Usage normalisation — PARITY WITH THE RUNNER. The same upstream reply is
 * normalised twice in this product: here (remote runs + proxy-routed chat,
 * which go through this proxy) and inside `@earendil-works/pi-ai`
 * (`dist/api/openai-completions.js`, `parseChunkUsage`), which
 * every platform-side Pi run uses. The two MUST agree bucket for bucket or the
 * same consumption is billed differently depending on where the run executed.
 * pi-ai's formula, reproduced exactly by {@link parseOpenAICompatibleUsage}:
 *
 *   cacheRead      = prompt_tokens_details.cached_tokens
 *                      ?? prompt_cache_hit_tokens ?? cached_tokens ?? 0
 *   cacheWrite     = prompt_tokens_details.cache_write_tokens ?? 0
 *   input          = max(0, prompt_tokens − cacheRead − cacheWrite)
 *
 * Three wire dialects feed the first line, in pi-ai's precedence order: OpenAI's
 * nested `prompt_tokens_details.cached_tokens` (`cached_tokens ⊂ prompt_tokens`),
 * DeepSeek's top-level `prompt_cache_hit_tokens` (`prompt_tokens = hit + miss`),
 * and Kimi's top-level `usage.cached_tokens`, which pi-ai added in 0.85.0. The
 * more specific field wins when several are present.
 *
 * `cache_write_tokens` is reported separately by OpenRouter-compatible
 * providers. Pi treats `cached_tokens` as cache reads and does not subtract
 * writes from it. Appstrate must preserve that exact partition so a call has
 * identical persisted usage on the proxy and in-container run paths.
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import { invalidRequest } from "../../lib/errors.ts";
import {
  asRecord,
  extractUsageObject,
  parseSseDataFrame,
  refuseLongCacheTtl,
  refuseNonStandardServiceTier,
  refuseUnmeteredFields,
  tokenCount,
  upstreamHeaders,
} from "./helpers.ts";

/**
 * Normalise an OpenAI-compatible `usage` object into the four DISJOINT cost
 * buckets, byte-for-byte equivalent to pi-ai's `parseChunkUsage` (see the
 * module doc for the formula and why parity is load-bearing). Returns null when
 * neither `prompt_tokens` nor `completion_tokens` is present — the caller
 * treats that as "no usage on this frame".
 */
function parseOpenAICompatibleUsage(u: Record<string, unknown>): UpstreamUsage | null {
  const prompt = tokenCount(u["prompt_tokens"]);
  const completion = tokenCount(u["completion_tokens"]);
  if (prompt === undefined && completion === undefined) return null;

  const details = asRecord(u["prompt_tokens_details"]);

  // Three vendors spelling the SAME live quantity three ways. This reads like
  // the `X ?? legacyX` chain docs/NO_TRANSITIONAL_CODE.md §1 prohibits and is
  // not one: §1 governs a name WE retired, and none of these three replaced
  // another — drop any branch and that vendor is mis-billed today. Most
  // specific first, pi-ai's own precedence. `?? `, not `||`: a genuine 0 from
  // the more specific source must not fall through to the next vendor's field.
  const reportedCacheRead =
    tokenCount(details?.["cached_tokens"]) ?? // OpenAI, OpenRouter
    tokenCount(u["prompt_cache_hit_tokens"]) ?? // DeepSeek
    tokenCount(u["cached_tokens"]); // Kimi
  return partitionOpenAIUsage({
    prompt,
    completion,
    reportedCacheRead,
    reportedCacheWrite: tokenCount(details?.["cache_write_tokens"]),
  });
}

/**
 * Split an OpenAI-family prompt total (cache buckets INCLUDED) into the four
 * disjoint cost buckets — pi-ai's formula on both OpenAI wires (Chat
 * Completions and Responses): `input = max(0, prompt − cacheRead − cacheWrite)`.
 */
export function partitionOpenAIUsage(u: {
  prompt: number | undefined;
  completion: number | undefined;
  reportedCacheRead: number | undefined;
  reportedCacheWrite: number | undefined;
}): UpstreamUsage {
  const cacheWrite = u.reportedCacheWrite ?? 0;
  const cacheRead = u.reportedCacheRead ?? 0;
  const input = Math.max(0, (u.prompt ?? 0) - cacheRead - cacheWrite);

  const result: UpstreamUsage = { inputTokens: input, outputTokens: u.completion ?? 0 };
  // Only surface a bucket the provider actually reported: an unreported bucket
  // stays NULL on the ledger row ("provider said nothing"), distinct from a
  // reported zero.
  if (u.reportedCacheRead !== undefined) result.cacheReadTokens = cacheRead;
  if (u.reportedCacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  return result;
}

/** The forwarded caller headers plus `Authorization: Bearer <upstream key>`. */
export function bearerUpstreamHeaders(incoming: Headers, apiKey: string): Headers {
  return upstreamHeaders(incoming, { authorization: `Bearer ${apiKey}` });
}

/** `apiShape` must match the route's. */
export function createOpenAICompatibleAdapter(apiShape: string): LlmProxyAdapter {
  const adapter: LlmProxyAdapter = {
    apiShape,

    buildUpstreamHeaders: bearerUpstreamHeaders,

    prepareRequest(body) {
      // OpenRouter: fallback lists and `provider` routing bill whichever
      // endpoint answered; `plugins` / `web_search_options` / `transforms` bill
      // apart from the tokens. No platform-built Pi model emits any of them
      // (`provider` needs `compat.openRouterRouting`); `store: false` is Pi's own.
      refuseUnmeteredFields(body, [
        "models",
        "route",
        "provider",
        "plugins",
        "web_search_options",
        "transforms",
        "store",
      ]);
      refuseNonStandardServiceTier(body);
      refuseLongCacheTtl(body);
      const stream = body["stream"];
      if (stream != null && typeof stream !== "boolean") {
        throw invalidRequest("`stream` must be a boolean", "stream");
      }
      // Streaming usage is opt-in on this wire: without
      // `stream_options.include_usage` no usage frame is emitted at all.
      if (stream !== true) return;
      const current = body["stream_options"];
      body["stream_options"] =
        current && typeof current === "object" && !Array.isArray(current)
          ? { ...(current as Record<string, unknown>), include_usage: true }
          : { include_usage: true };
    },

    parseJsonUsage(body) {
      const u = extractUsageObject(body);
      if (!u) return null;
      return parseOpenAICompatibleUsage(u);
    },

    parseSseUsage(events) {
      // Iterate newest-to-oldest — OpenAI-compatible providers emit `usage`
      // only on the terminal frame.
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

export const openaiCompletionsAdapter = createOpenAICompatibleAdapter("openai-completions");
