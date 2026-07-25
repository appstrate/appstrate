// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic-messages adapter for `/api/llm-proxy/anthropic-messages/*`.
 *
 * Auth: standard API keys (`sk-ant-…`) → `x-api-key: <key>`. OAuth
 * subscription tokens (`sk-ant-oat-…`) are NOT supported by this
 * adapter: Anthropic's Consumer ToS forbids using such tokens with
 * any third-party product, so the platform refuses to forward them.
 * Operators with a subscription plan who want to use Anthropic inside
 * Appstrate must either (a) use the Anthropic API key flow (this
 * adapter), or (b) install an external module that owns the
 * subscription wire format end-to-end.
 *
 * Wire format:
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
import { extractUsageObject, parseSseDataFrame, tokenCount } from "./helpers.ts";

function readForwardedHeader(incoming: Headers, name: string): string | null {
  for (const [k, v] of incoming) {
    if (k.toLowerCase() === name) return v;
  }
  return null;
}

export const anthropicMessagesAdapter: LlmProxyAdapter = {
  apiShape: "anthropic-messages",

  buildUpstreamHeaders(incoming, apiKey) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    };

    const callerBeta = readForwardedHeader(incoming, "anthropic-beta");
    if (callerBeta) headers["anthropic-beta"] = callerBeta;

    // Default anthropic-version if the caller omitted one — upstream
    // returns 400 without it.
    const callerVersion = readForwardedHeader(incoming, "anthropic-version");
    headers["anthropic-version"] = callerVersion ?? "2023-06-01";

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

/**
 * Anthropic's four wire fields map 1:1 onto the four cost buckets — unlike the
 * OpenAI-compatible wire, `input_tokens` already EXCLUDES both cache counts, so
 * no subtraction is needed and there is no `cache_write`-folded-into-`cache_read`
 * dialect to reconcile. This is the same mapping pi-ai applies
 * (`dist/providers/anthropic.js:336-339, 482-493`), so the proxy and the runner
 * price an identical Anthropic reply identically.
 */
function usageFromAnthropicFields(u: Record<string, unknown>): UpstreamUsage {
  const input = tokenCount(u["input_tokens"]);
  const output = tokenCount(u["output_tokens"]);
  const cacheRead = tokenCount(u["cache_read_input_tokens"]);
  const cacheWrite = tokenCount(u["cache_creation_input_tokens"]);
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
