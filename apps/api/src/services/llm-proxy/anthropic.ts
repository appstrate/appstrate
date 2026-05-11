// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic-messages adapter for `/api/llm-proxy/anthropic-messages/*`.
 *
 * Protocol specifics:
 *   - Auth (two flavours, decided by upstream key prefix):
 *       1. Standard API keys (`sk-ant-…`)        → `x-api-key: <key>`.
 *       2. OAuth long-lived tokens (`sk-ant-oat-…`) → `Authorization:
 *          Bearer <key>` + Claude-Code identity headers
 *          (`anthropic-beta: claude-code-20250219,oauth-2025-04-20,…`,
 *          `user-agent: claude-cli/<v>`, `x-app: cli`,
 *          `anthropic-dangerous-direct-browser-access: true`). Anthropic
 *          gates OAuth tokens to Claude-Code identity server-side, so
 *          omitting any of these returns 401 `invalid x-api-key`. We
 *          mirror what `pi-ai`'s anthropic provider sends when it
 *          detects an OAuth token locally — the runner-pi path works
 *          because pi-ai sees the raw key; the proxy path needs the
 *          same wire format because pi-ai sees only the Appstrate
 *          bearer placeholder and skips the OAuth branch.
 *   - `anthropic-version` and `anthropic-beta` are forwarded verbatim
 *     from the caller so `prompt-caching-2024-07-31`, `extended-thinking`
 *     and similar beta headers pass through untouched. For OAuth tokens
 *     the caller's beta list is appended to the OAuth-required betas
 *     rather than replacing them.
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

import {
  CLAUDE_CODE_CLI_VERSION,
  CLAUDE_CODE_IDENTITY_HEADERS,
  CLAUDE_CODE_OAUTH_BETAS,
} from "@appstrate/core/sidecar-types";
import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import {
  extractUsageObject,
  numberOrUndefined,
  parseSseDataFrame,
  substituteModelJson,
} from "./helpers.ts";

function isOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

function readForwardedHeader(incoming: Headers, name: string): string | null {
  for (const [k, v] of incoming) {
    if (k.toLowerCase() === name) return v;
  }
  return null;
}

export const anthropicMessagesAdapter: LlmProxyAdapter = {
  api: "anthropic-messages",

  substituteModel(rawBody, realModelId) {
    return substituteModelJson(rawBody, realModelId);
  },

  buildUpstreamHeaders(incoming, upstreamApiKey) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isOAuthToken(upstreamApiKey)) {
      // OAuth: Bearer auth + Claude-Code identity. Caller-supplied
      // betas are merged into (not overriding) the OAuth-required set
      // so things like `prompt-caching-2024-07-31` keep working.
      headers["Authorization"] = `Bearer ${upstreamApiKey}`;
      headers["user-agent"] = `claude-cli/${CLAUDE_CODE_CLI_VERSION}`;
      Object.assign(headers, CLAUDE_CODE_IDENTITY_HEADERS);
      const callerBeta = readForwardedHeader(incoming, "anthropic-beta");
      const callerBetas = callerBeta ? callerBeta.split(",").map((s) => s.trim()) : [];
      const merged = Array.from(new Set([...CLAUDE_CODE_OAUTH_BETAS, ...callerBetas])).filter(
        (s) => s.length > 0,
      );
      headers["anthropic-beta"] = merged.join(",");
    } else {
      headers["x-api-key"] = upstreamApiKey;
      const callerBeta = readForwardedHeader(incoming, "anthropic-beta");
      if (callerBeta) headers["anthropic-beta"] = callerBeta;
    }

    // Default anthropic-version if the caller omitted one — upstream
    // returns 400 without it. Applies to both auth flavours.
    const callerVersion = readForwardedHeader(incoming, "anthropic-version");
    headers["anthropic-version"] = callerVersion ?? "2023-06-01";

    // `anthropic-dangerous-direct-browser-access` from the caller wins
    // over our OAuth default if present (rare, but explicit caller
    // intent should not be silently dropped).
    const callerBrowserHeader = readForwardedHeader(
      incoming,
      "anthropic-dangerous-direct-browser-access",
    );
    if (callerBrowserHeader) {
      headers["anthropic-dangerous-direct-browser-access"] = callerBrowserHeader;
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
