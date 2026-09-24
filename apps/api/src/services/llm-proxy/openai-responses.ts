// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI Responses adapter (`POST /v1/responses`) — the wire of every provider
 * whose apiShape is `openai-responses` (`openai`, `xai`).
 *
 * Request side is the Chat Completions adapter's bearer auth. There is no usage opt-in to force — this API always
 * reports usage. {@link prepareRequest} refuses what the vendor bills outside the
 * reported tokens (background jobs, chained, stored or prompt-template state,
 * non-default service tiers, server-executed tools, a `cache_control` TTL other
 * than `5m`) and forces `store: false`,
 * so no response is kept upstream for later replay.
 *
 * Usage: a non-streaming reply carries it at the top level (`body.usage`); a
 * stream carries it only in the terminal event's `response.usage`
 * (`response.completed`, or `response.incomplete` when truncated — the earlier
 * `response.created` / `response.in_progress` events hold `usage: null`).
 * Mapping — PARITY WITH THE RUNNER, pi-ai `openai-responses-shared.js`
 * (`finalizeResponse`):
 *
 *   cacheRead  = input_tokens_details.cached_tokens
 *   cacheWrite = input_tokens_details.cache_write_tokens
 *   input      = max(0, input_tokens − cacheRead − cacheWrite)
 *   output     = output_tokens   (reasoning_tokens ⊂ output_tokens)
 *
 * One deliberate departure: when `total_tokens` is reported, output is
 * `max(output_tokens, total_tokens − input_tokens)`, so a vendor counting
 * reasoning outside `output_tokens` (suspected: xAI) is not under-metered.
 * Identical to pi-ai whenever the three fields add up.
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
} from "./helpers.ts";
import { bearerUpstreamHeaders, partitionOpenAIUsage } from "./openai.ts";

function parseResponsesUsage(u: Record<string, unknown>): UpstreamUsage | null {
  const prompt = tokenCount(u["input_tokens"]);
  const reported = tokenCount(u["output_tokens"]);
  if (prompt === undefined && reported === undefined) return null;
  const total = tokenCount(u["total_tokens"]);
  const completion =
    total === undefined ? reported : Math.max(reported ?? 0, total - (prompt ?? 0));
  const details = asRecord(u["input_tokens_details"]);
  return partitionOpenAIUsage({
    prompt,
    completion,
    reportedCacheRead: tokenCount(details?.["cached_tokens"]),
    reportedCacheWrite: tokenCount(details?.["cache_write_tokens"]),
  });
}

const UNMETERED_FIELDS = ["background", "previous_response_id", "conversation", "prompt"];
/** Tools the caller executes; every other type runs (and bills) server-side. */
const CLIENT_TOOL_TYPES = new Set<unknown>(["function", "custom"]);

export const openaiResponsesAdapter: LlmProxyAdapter = {
  apiShape: "openai-responses",

  buildUpstreamHeaders: bearerUpstreamHeaders,

  prepareRequest(body) {
    refuseUnmeteredFields(body, UNMETERED_FIELDS);
    refuseNonStandardServiceTier(body);
    refuseLongCacheTtl(body);
    const tools = body["tools"];
    if (Array.isArray(tools) && tools.some((t) => !CLIENT_TOOL_TYPES.has(asRecord(t)?.["type"]))) {
      throw invalidRequest("Only `function` and `custom` tools are supported", "tools");
    }
    body["store"] = false;
  },

  parseJsonUsage(body) {
    const u = extractUsageObject(body);
    return u ? parseResponsesUsage(u) : null;
  },

  parseSseUsage(events) {
    // Newest first: only the terminal event carries a non-null usage.
    for (let i = events.length - 1; i >= 0; i--) {
      const response = asRecord(parseSseDataFrame(events[i]!))?.["response"];
      const parsed = openaiResponsesAdapter.parseJsonUsage(response);
      if (parsed) return parsed;
    }
    return null;
  },
};
