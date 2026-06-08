// SPDX-License-Identifier: Apache-2.0

/**
 * Codex (ChatGPT subscription) adapter for
 * `/api/llm-proxy/openai-codex-responses/*`.
 *
 * Lets the lightweight chat (no runtime, no run sidecar) reach a ChatGPT
 * subscription the same way an agent run does — by going through the proxy
 * instead of the sidecar. The codex wire-format quirks the chatgpt.com
 * backend enforces (`originator`, `openai-beta`, `user-agent`, `accept`,
 * `chatgpt-account-id`) are NOT hardcoded here: they live declaratively on
 * the provider's `oauthWireFormat` and are applied generically by the core
 * (mirroring `run-launcher/pi.ts`), so this adapter only owns the
 * protocol-shape concerns. The OAuth access token arrives as `apiKey`
 * (kept fresh by the credential refresh worker) and is sent as a Bearer.
 *
 * Wire format: the chatgpt.com Codex backend speaks the OpenAI Responses
 * API (`instructions`/`input`/`include`, SSE only). Usage:
 *   - Non-streaming: `body.usage.{input_tokens,output_tokens,
 *     input_tokens_details.cached_tokens}`.
 *   - Streaming: the terminal `response.completed` frame carries the
 *     canonical totals under `response.usage`.
 */

import type { LlmProxyAdapter, UpstreamUsage } from "./types.ts";
import { numberOrUndefined, parseSseDataFrame } from "./helpers.ts";

function usageFromResponsesFields(u: Record<string, unknown>): UpstreamUsage | null {
  const input = numberOrUndefined(u["input_tokens"]);
  const output = numberOrUndefined(u["output_tokens"]);
  if (input === undefined && output === undefined) return null;
  const result: UpstreamUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  };
  const details = (u["input_tokens_details"] ?? null) as Record<string, unknown> | null;
  if (details && typeof details === "object") {
    const cached = numberOrUndefined(details["cached_tokens"]);
    if (cached !== undefined) result.cacheReadTokens = cached;
  }
  return result;
}

/** Read `usage` from either a top-level body or a `response`-wrapped frame. */
function readResponsesUsage(node: unknown): UpstreamUsage | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  // Streaming frames wrap the payload as `{ type, response: { usage } }`;
  // the non-streaming body carries `usage` at the top level.
  const usage =
    (obj["usage"] as Record<string, unknown> | undefined) ??
    ((obj["response"] as Record<string, unknown> | undefined)?.["usage"] as
      | Record<string, unknown>
      | undefined);
  if (!usage || typeof usage !== "object") return null;
  return usageFromResponsesFields(usage);
}

export const openaiCodexResponsesAdapter: LlmProxyAdapter = {
  apiShape: "openai-codex-responses",

  buildUpstreamHeaders(_incoming, apiKey) {
    // Protocol-shape headers only. The codex identity/quirk headers
    // (originator, openai-beta, user-agent, accept, chatgpt-account-id)
    // come from the provider's `oauthWireFormat`, applied by the core.
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  },

  parseJsonUsage(body) {
    return readResponsesUsage(body);
  },

  parseSseUsage(events) {
    // Totals land on the terminal `response.completed` frame; scan
    // newest-to-oldest and take the first frame that carries usage.
    for (let i = events.length - 1; i >= 0; i--) {
      const frame = parseSseDataFrame(events[i]!);
      const usage = readResponsesUsage(frame);
      if (usage) return usage;
    }
    return null;
  },
};
