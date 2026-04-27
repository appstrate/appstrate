// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic-messages adapter for `/api/llm-proxy/anthropic-messages/*`.
 *
 * Protocol specifics:
 *   - Auth: `x-api-key` header (Bearer form also accepted by upstream for
 *     OAuth long-lived tokens — we stick to `x-api-key` since that is what
 *     `ResolvedProxyModel.upstreamApiKey` holds in practice).
 *   - `anthropic-version` and `anthropic-beta` are forwarded verbatim
 *     from the caller so `prompt-caching-2024-07-31`, `extended-thinking`
 *     and similar beta headers pass through untouched.
 *   - `cache_control` blocks in the request body MUST pass through
 *     unaltered — we only rewrite `body.model`, never touch `messages`,
 *     `system`, or `metadata`.
 *   - Non-streaming usage: `body.usage.{input_tokens,output_tokens,
 *     cache_read_input_tokens,cache_creation_input_tokens}`.
 *   - Streaming usage: the final `message_delta` frame carries the
 *     canonical `usage.output_tokens`; the opening `message_start` frame
 *     carries `usage.input_tokens` + cache token counts. We merge the
 *     two to produce the metering row.
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import {
  extractUsageObject,
  numberOrUndefined,
  parseSseDataFrame,
  substituteModelJson,
} from "./helpers.ts";

const HEADERS_TO_FORWARD = new Set([
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
]);

export const anthropicMessagesAdapter: LlmProxyAdapter = {
  api: "anthropic-messages",

  substituteModel(rawBody, realModelId) {
    return substituteModelJson(rawBody, realModelId);
  },

  buildUpstreamHeaders(incoming, upstreamApiKey) {
    const headers: Record<string, string> = {
      "x-api-key": upstreamApiKey,
      "Content-Type": "application/json",
    };
    // Default anthropic-version if the caller omitted one — upstream
    // returns 400 without it.
    const hasVersion = Array.from(incoming.keys()).some(
      (k) => k.toLowerCase() === "anthropic-version",
    );
    if (!hasVersion) headers["anthropic-version"] = "2023-06-01";
    for (const [k, v] of incoming) {
      if (HEADERS_TO_FORWARD.has(k.toLowerCase())) headers[k] = v;
    }
    return headers;
  },

  parseJsonUsage(body) {
    const u = extractUsageObject(body);
    if (!u) return null;
    return usageFromAnthropicFields(u);
  },

  parseSseUsage(events) {
    // Anthropic emits usage across two frames: `message_start` seeds
    // input + cache counts, `message_delta` seeds output. We merge.
    let aggregate: UpstreamUsage | null = null;
    for (const raw of events) {
      const frame = parseSseDataFrame(raw);
      if (!frame || typeof frame !== "object") continue;
      const obj = frame as Record<string, unknown>;
      // `message_start` → obj.message.usage
      if (obj["type"] === "message_start") {
        const message = obj["message"];
        if (message && typeof message === "object") {
          const u = (message as Record<string, unknown>)["usage"];
          if (u && typeof u === "object") {
            aggregate = merge(aggregate, usageFromAnthropicFields(u as Record<string, unknown>));
          }
        }
      }
      // `message_delta` → obj.usage
      if (obj["type"] === "message_delta") {
        const u = obj["usage"];
        if (u && typeof u === "object") {
          aggregate = merge(aggregate, usageFromAnthropicFields(u as Record<string, unknown>));
        }
      }
    }
    return aggregate;
  },
};

function usageFromAnthropicFields(u: Record<string, unknown>): UpstreamUsage {
  const input = numberOrUndefined(u["input_tokens"]);
  const output = numberOrUndefined(u["output_tokens"]);
  const cacheRead = numberOrUndefined(u["cache_read_input_tokens"]);
  const cacheWrite = numberOrUndefined(u["cache_creation_input_tokens"]);
  const result: UpstreamUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  };
  if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  return result;
}

function merge(a: UpstreamUsage | null, b: UpstreamUsage): UpstreamUsage {
  if (!a) return b;
  // Later frames win for fields they populate. `message_delta.output_tokens`
  // is CUMULATIVE — the platform must keep the final value, not the seed
  // from `message_start`. Zero is treated as "not emitted" to avoid wiping
  // the seed when a mid-stream frame only updates one field.
  return {
    inputTokens: b.inputTokens > 0 ? b.inputTokens : a.inputTokens,
    outputTokens: b.outputTokens > 0 ? b.outputTokens : a.outputTokens,
    cacheReadTokens: b.cacheReadTokens ?? a.cacheReadTokens,
    cacheWriteTokens: b.cacheWriteTokens ?? a.cacheWriteTokens,
  };
}
