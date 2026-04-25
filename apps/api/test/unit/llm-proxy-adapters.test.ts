// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the two ships-today LLM-proxy adapters.
 *
 * Covers the pure transformations each adapter performs — model
 * substitution, upstream-header construction, and usage extraction from
 * both non-streaming JSON bodies and accumulated SSE frames.
 *
 * Anything touching the HTTP round-trip, permissions, or DB writes
 * lives in the route-level integration tests in
 * `apps/api/test/integration/routes/llm-proxy.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { openaiCompletionsAdapter } from "../../src/services/llm-proxy/openai.ts";
import { anthropicMessagesAdapter } from "../../src/services/llm-proxy/anthropic.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("openaiCompletionsAdapter", () => {
  it("api discriminator matches the /api/llm-proxy/openai-completions/ route", () => {
    expect(openaiCompletionsAdapter.api).toBe("openai-completions");
  });

  it("rewrites body.model while preserving the rest of the payload verbatim", () => {
    const original = {
      model: "m_preset_abc",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      response_format: { type: "json_object" },
      tools: [{ type: "function", function: { name: "echo", parameters: {} } }],
    };
    const rewritten = openaiCompletionsAdapter.substituteModel(
      enc.encode(JSON.stringify(original)),
      "gpt-4o-2024-08-06",
    );
    const parsed = JSON.parse(dec.decode(rewritten));
    expect(parsed.model).toBe("gpt-4o-2024-08-06");
    expect(parsed.messages).toEqual(original.messages);
    expect(parsed.stream).toBe(true);
    expect(parsed.response_format).toEqual(original.response_format);
    expect(parsed.tools).toEqual(original.tools);
  });

  it("injects Authorization: Bearer <upstreamApiKey>", () => {
    const headers = openaiCompletionsAdapter.buildUpstreamHeaders(
      new Headers({ "x-something": "ignored" }),
      "sk-upstream",
    );
    expect(headers["Authorization"]).toBe("Bearer sk-upstream");
    expect(headers["Content-Type"]).toBe("application/json");
    // The incoming Authorization (the caller's Appstrate bearer) MUST
    // NOT leak to the upstream — the platform mints a fresh one.
    expect(headers["x-something"]).toBeUndefined();
  });

  it("parses non-streaming JSON usage with prompt/completion tokens", () => {
    const usage = openaiCompletionsAdapter.parseJsonUsage({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        prompt_tokens_details: { cached_tokens: 32 },
      },
    });
    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 32,
    });
  });

  it("returns null when usage is missing from the JSON body", () => {
    expect(openaiCompletionsAdapter.parseJsonUsage({ id: "x" })).toBeNull();
    expect(openaiCompletionsAdapter.parseJsonUsage(null)).toBeNull();
  });

  it("parses SSE usage from the final data frame", () => {
    const frames = [
      `data: {"id":"x","choices":[{"delta":{"content":"he"}}]}`,
      `data: {"id":"x","choices":[{"delta":{"content":"llo"}}]}`,
      `data: {"id":"x","usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}`,
      `data: [DONE]`,
    ];
    const usage = openaiCompletionsAdapter.parseSseUsage(frames);
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
    });
  });
});

describe("anthropicMessagesAdapter", () => {
  it("api discriminator matches the /api/llm-proxy/anthropic-messages/ route", () => {
    expect(anthropicMessagesAdapter.api).toBe("anthropic-messages");
  });

  it("rewrites body.model and leaves cache_control / system / tools untouched", () => {
    const original = {
      model: "m_preset_claude",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "ctx", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "search", input_schema: {} }],
      stream: true,
    };
    const rewritten = anthropicMessagesAdapter.substituteModel(
      enc.encode(JSON.stringify(original)),
      "claude-sonnet-4-5-20250929",
    );
    const parsed = JSON.parse(dec.decode(rewritten));
    expect(parsed.model).toBe("claude-sonnet-4-5-20250929");
    expect(parsed.messages).toEqual(original.messages);
    expect(parsed.system).toEqual(original.system);
    expect(parsed.tools).toEqual(original.tools);
    expect(parsed.max_tokens).toBe(1024);
    expect(parsed.stream).toBe(true);
  });

  it("injects x-api-key, defaults anthropic-version when caller omits it", () => {
    const headers = anthropicMessagesAdapter.buildUpstreamHeaders(
      new Headers({ accept: "application/json" }),
      "sk-anthropic",
    );
    expect(headers["x-api-key"]).toBe("sk-anthropic");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("forwards anthropic-version + anthropic-beta when caller supplies them", () => {
    const headers = anthropicMessagesAdapter.buildUpstreamHeaders(
      new Headers({
        "anthropic-version": "2024-10-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      }),
      "sk-anthropic",
    );
    expect(headers["anthropic-version"]).toBe("2024-10-01");
    expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
  });

  it("parses non-streaming JSON usage with cache tokens", () => {
    const usage = anthropicMessagesAdapter.parseJsonUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
    });
  });

  it("merges message_start (input + cache) with message_delta (output) frames", () => {
    const frames = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":150,"cache_read_input_tokens":120,"cache_creation_input_tokens":30,"output_tokens":1}}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}`,
      `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ];
    const usage = anthropicMessagesAdapter.parseSseUsage(frames);
    expect(usage).toEqual({
      inputTokens: 150,
      outputTokens: 42,
      cacheReadTokens: 120,
      cacheWriteTokens: 30,
    });
  });

  it("returns null when no usage frames were observed", () => {
    expect(anthropicMessagesAdapter.parseSseUsage([])).toBeNull();
    expect(
      anthropicMessagesAdapter.parseSseUsage([
        'event: content_block_delta\ndata: {"type":"content_block_delta"}',
      ]),
    ).toBeNull();
  });
});
