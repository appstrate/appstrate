// SPDX-License-Identifier: Apache-2.0

/**
 * Codex (ChatGPT subscription) adapter for `/api/llm-proxy/*` — the
 * FIRST-PARTY-ONLY subscription route.
 *
 * Policy: subscription providers deliberately have no third-party proxy
 * path (an API key must never be able to spend someone's personal
 * ChatGPT subscription). This adapter exists for the platform's own
 * interactive surfaces — the route that mounts it accepts only
 * first-party auth methods (`chat-loopback`, `oauth2-dashboard`), the
 * same trust boundary as the in-container sidecar that already serves
 * these credentials to runs. Ratified with Pierre: subscriptions are
 * usable inside Appstrate by their owners' org.
 *
 * Wire format: the codex module's `oauthWireFormat` (identity headers —
 * `originator`/`openai-beta`/CLI `user-agent`/`accept: text/event-stream`,
 * the `chatgpt-account-id` echo — plus `forceStream`/`forceStore` body
 * coercion) is applied generically in `core.ts` from the registry, the
 * single source of truth shared with the sidecar. This adapter only adds
 * Bearer auth and the usage parser for the Responses surface.
 *
 * Usage accounting: the Responses API emits a terminal
 * `response.completed` SSE frame carrying
 * `response.usage.{input_tokens, output_tokens, input_tokens_details}`.
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import { numberOrUndefined, parseSseDataFrame } from "./helpers.ts";

function usageFrom(obj: unknown): UpstreamUsage | null {
  if (!obj || typeof obj !== "object") return null;
  const usage = (obj as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = numberOrUndefined(u["input_tokens"]);
  const output = numberOrUndefined(u["output_tokens"]);
  if (input === undefined && output === undefined) return null;
  const result: UpstreamUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  const details = (u["input_tokens_details"] ?? null) as Record<string, unknown> | null;
  if (details && typeof details === "object") {
    const cached = numberOrUndefined(details["cached_tokens"]);
    if (cached !== undefined) result.cacheReadTokens = cached;
  }
  return result;
}

export const codexResponsesAdapter: LlmProxyAdapter = {
  apiShape: "openai-codex-responses",

  buildUpstreamHeaders(_incoming, apiKey) {
    // Identity headers + accountId echo come from the module wireFormat
    // (applied generically in core.ts). Bearer auth is the OAuth
    // subscription access token.
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  },

  parseJsonUsage(body) {
    // Non-streaming responses are rejected upstream, but keep the parser
    // total: a `response.completed`-shaped object or a bare response body.
    const response = (body as { response?: unknown })?.response ?? body;
    return usageFrom(response);
  },

  parseSseUsage(events) {
    // `response.completed` is the terminal frame — walk newest-to-oldest.
    for (let i = events.length - 1; i >= 0; i--) {
      const frame = parseSseDataFrame(events[i]!);
      if (!frame) continue;
      const response = (frame as { response?: unknown }).response;
      const parsed = usageFrom(response);
      if (parsed) return parsed;
    }
    return null;
  },
};
