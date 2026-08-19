// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI-compatible adapters for `/api/llm-proxy/*`.
 *
 * The `openai-completions` and `mistral-conversations` apiShapes speak
 * the same wire (snake_case `prompt_tokens` / `completion_tokens`, SSE
 * usage on the terminal frame). The only protocol-specific difference is
 * which inbound headers get forwarded — expressed here as `AdapterOptions`.
 * Adding a new OpenAI-compatible apiShape is a single call to
 * {@link createOpenAICompatibleAdapter}.
 *
 * Usage normalisation — PARITY WITH THE RUNNER. The same upstream reply is
 * normalised twice in this product: here (remote runs + chat's ai-sdk path,
 * which go through this proxy) and inside `@earendil-works/pi-ai`
 * (`dist/providers/openai-completions.js:795-818`, `parseChunkUsage`), which
 * every platform-side Pi run uses. The two MUST agree bucket for bucket or the
 * same consumption is billed differently depending on where the run executed.
 * pi-ai's formula, reproduced exactly by {@link parseOpenAICompatibleUsage}:
 *
 *   reportedCached = prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? 0
 *   cacheWrite     = prompt_tokens_details.cache_write_tokens ?? 0
 *   cacheRead      = cacheWrite > 0 ? max(0, reportedCached − cacheWrite) : reportedCached
 *   input          = max(0, prompt_tokens − cacheRead − cacheWrite)
 *
 * Two wire dialects feed the first line: OpenAI's nested
 * `prompt_tokens_details.cached_tokens` (`cached_tokens ⊂ prompt_tokens`) and
 * DeepSeek's top-level `prompt_cache_hit_tokens` (`prompt_tokens = hit + miss`).
 * The nested field wins when both are present — pi-ai's precedence.
 *
 * `cache_write_tokens` is the field the previous implementation ignored: a
 * provider that reports it (OpenRouter, the case pi-ai explicitly handles)
 * folds those tokens into `cached_tokens`, so leaving them in `cacheRead`
 * priced cache WRITES at the cache-READ rate (≈0.1× input instead of ≈1.25×
 * input — an order of magnitude off, in the customer's favour on a
 * platform-paid model).
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import { extractUsageObject, parseSseDataFrame, tokenCount } from "./helpers.ts";

interface AdapterOptions {
  /** Protocol family discriminator — must match the route's `apiShape`. */
  apiShape: string;
  /** Inbound header names (lowercase) the adapter forwards to upstream. */
  forwardHeaders?: ReadonlySet<string>;
}

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

  const rawDetails = u["prompt_tokens_details"];
  const details =
    rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : null;

  // `?? ` chain, not `||`: a genuine 0 from the more specific source must not
  // fall through to the other dialect's field.
  const reportedCached =
    tokenCount(details?.["cached_tokens"]) ?? tokenCount(u["prompt_cache_hit_tokens"]);
  const reportedCacheWrite = tokenCount(details?.["cache_write_tokens"]);

  const cacheWrite = reportedCacheWrite ?? 0;
  const cached = reportedCached ?? 0;
  // A provider that reports cache writes counts them inside `cached_tokens`
  // (observed on OpenRouter) — subtract them back out so the two buckets stay
  // disjoint and each is priced at its own rate.
  const cacheRead = cacheWrite > 0 ? Math.max(0, cached - cacheWrite) : cached;
  const input = Math.max(0, (prompt ?? 0) - cacheRead - cacheWrite);

  const result: UpstreamUsage = { inputTokens: input, outputTokens: completion ?? 0 };
  // Only surface a bucket the provider actually reported: an unreported bucket
  // stays NULL on the ledger row ("provider said nothing"), distinct from a
  // reported zero.
  if (reportedCached !== undefined) result.cacheReadTokens = cacheRead;
  if (reportedCacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  return result;
}

export function createOpenAICompatibleAdapter(opts: AdapterOptions): LlmProxyAdapter {
  const forwardHeaders = opts.forwardHeaders ?? new Set<string>();

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

    forceUsageReporting(body) {
      // Streaming usage is opt-in on this wire: without
      // `stream_options.include_usage` the provider emits NO usage frame at all
      // and the call — already paid for upstream — would land in the ledger as
      // an unmetered row. Billing must not depend on the caller SDK setting the
      // flag, so the platform sets it for every preset it forwards.
      if (body["stream"] !== true) return;
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

export const openaiCompletionsAdapter = createOpenAICompatibleAdapter({
  apiShape: "openai-completions",
  forwardHeaders: new Set(["openai-organization", "openai-beta"]),
});
