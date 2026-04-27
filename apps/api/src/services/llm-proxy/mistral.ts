// SPDX-License-Identifier: Apache-2.0

/**
 * Mistral-conversations adapter for `/api/llm-proxy/mistral-conversations/*`.
 *
 * The protocol family name is inherited from `pi-ai`'s registry, but the
 * underlying wire format is plain `POST /v1/chat/completions` against
 * `https://api.mistral.ai` — pi-ai dispatches Mistral models through the
 * official `@mistralai/mistralai` SDK's `chat.stream(...)`, which targets
 * the chat-completions endpoint, NOT Mistral's Beta `/v1/conversations`
 * agentic API.
 *
 * Protocol specifics:
 *   - Auth: `Authorization: Bearer <key>`
 *   - Body shape: snake_case OpenAI-compatible
 *     (`{ model, messages, temperature, max_tokens, stream, tools, … }`)
 *   - Non-streaming usage: `body.usage.{prompt_tokens,completion_tokens,
 *     total_tokens}` — identical field names to OpenAI.
 *   - Streaming usage: same convention as OpenAI — usage lands on the
 *     terminal `data: {…}` frame when the caller opts in. If the SDK
 *     does not request usage on the stream (default behaviour today),
 *     `parseSseUsage` returns null and the metering row is skipped, same
 *     fallback as the OpenAI adapter.
 *
 * No request headers are forwarded (Mistral has no equivalent of
 * `openai-organization` / `openai-beta`). The Mistral SDK ships an
 * `x-affinity` header for sticky sessions; we intentionally do NOT
 * forward it because preset routing is server-side and that header has
 * no effect once the platform terminates auth.
 */

import type { LlmProxyAdapter } from "./types.ts";
import { logger } from "../../lib/logger.ts";

export const mistralConversationsAdapter: LlmProxyAdapter = {
  api: "mistral-conversations",

  substituteModel(rawBody, realModelId) {
    return substituteModelJson(rawBody, realModelId);
  },

  buildUpstreamHeaders(_incoming, upstreamApiKey) {
    return {
      Authorization: `Bearer ${upstreamApiKey}`,
      "Content-Type": "application/json",
    };
  },

  parseJsonUsage(body) {
    const u = extractUsageObject(body);
    if (!u) return null;
    const input = numberOrUndefined(u["prompt_tokens"]);
    const output = numberOrUndefined(u["completion_tokens"]);
    if (input === undefined && output === undefined) return null;
    return {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
    };
  },

  parseSseUsage(events) {
    // Mirror the OpenAI strategy — usage rides on the terminal frame
    // when the client opted in. Iterate newest-to-oldest so we pick the
    // canonical final tally rather than any zeroed seed earlier in the
    // stream.
    for (let i = events.length - 1; i >= 0; i--) {
      const frame = parseSseDataFrame(events[i]!);
      if (!frame) continue;
      const parsed = mistralConversationsAdapter.parseJsonUsage(frame);
      if (parsed) return parsed;
    }
    return null;
  },
};

function substituteModelJson(rawBody: Uint8Array, realModelId: string): Uint8Array {
  const text = new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn("llm-proxy: mistral request body is not JSON — forwarding as-is", {
      error: err instanceof Error ? err.message : String(err),
    });
    return rawBody;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawBody;
  }
  (parsed as Record<string, unknown>)["model"] = realModelId;
  return new TextEncoder().encode(JSON.stringify(parsed));
}

function extractUsageObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as Record<string, unknown>)["usage"];
  if (!u || typeof u !== "object") return null;
  return u as Record<string, unknown>;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseSseDataFrame(chunk: string): unknown | null {
  const lines = chunk.split("\n");
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  const payload = data.join("");
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
