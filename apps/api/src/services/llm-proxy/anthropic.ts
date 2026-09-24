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
 *   - `anthropic-version` is forwarded (defaulted when absent). `anthropic-beta`
 *     keeps only the betas Pi's own client sends (`PI_BETAS`): a beta can switch
 *     on a feature billed outside the reported tokens, and an allowlist also
 *     closes the ones Anthropic has not shipped yet. {@link prepareRequest}
 *     refuses the billable body fields Pi never sends (`fallbacks`,
 *     server-executed tools, a `service_tier` other than `standard_only`).
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
import { invalidRequest } from "../../lib/errors.ts";
import {
  asRecord,
  extractUsageObject,
  parseSseDataFrame,
  refuseUnmeteredFields,
  tokenCount,
  upstreamHeaders,
} from "./helpers.ts";

/**
 * pi-ai `getBetaFeatures` (`api/anthropic-messages.js`) for an API key under
 * `PLATFORM_MODEL_COMPAT` — never its fallback or OAuth betas.
 */
const PI_BETAS: ReadonlySet<string> = new Set([
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-output-config-2026-07-01",
  "thinking-binding-controls-2026-08-01",
  "mid-conversation-tool-changes-2026-07-01",
]);

export const anthropicMessagesAdapter: LlmProxyAdapter = {
  apiShape: "anthropic-messages",

  buildUpstreamHeaders(incoming, apiKey) {
    const headers = upstreamHeaders(incoming, { "x-api-key": apiKey });

    // Billing guard, applied to what the shared policy forwarded.
    const betas = (headers.get("anthropic-beta") ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter((beta) => PI_BETAS.has(beta));
    if (betas.length > 0) headers.set("anthropic-beta", betas.join(","));
    else headers.delete("anthropic-beta");

    // Upstream answers 400 without it.
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");

    return headers;
  },

  prepareRequest(body) {
    refuseUnmeteredFields(body, ["fallbacks"]);
    // `auto` may serve at priority-tier rates; Pi sends no tier (= standard).
    const tier = body["service_tier"];
    if (tier != null && tier !== "standard_only") {
      throw invalidRequest("`service_tier` must be `standard_only`", "service_tier");
    }
    // A typed tool other than `custom` is Anthropic-defined; Pi declares none.
    const tools = body["tools"];
    if (
      Array.isArray(tools) &&
      tools.some((t) => (asRecord(t)?.["type"] ?? "custom") !== "custom")
    ) {
      throw invalidRequest("Only custom tools are supported", "tools");
    }
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
