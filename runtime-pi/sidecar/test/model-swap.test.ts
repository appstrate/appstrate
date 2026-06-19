// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 3 (model alias) — the sidecar's bidirectional `model` rewrite, the
 * inference-data-path half of #727. Request `model` alias→real; response
 * `model` real→alias for non-stream JSON AND streaming SSE (OpenAI top-level +
 * Anthropic `message_start` nesting). The hard invariant: a model id mentioned
 * inside generated content is NEVER clobbered (match by value at known paths,
 * not a blind string replace).
 */

import { describe, it, expect } from "bun:test";
import {
  swapRequestModel,
  swapResponseModelJson,
  createSseModelSwapStream,
  scrubModelText,
  isAliasableApiShape,
} from "../model-swap.ts";

const swap = { alias: "appstrate-medium", real: "deepseek-chat" };

async function pipeSse(input: string): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  }).pipeThrough(createSseModelSwapStream(swap));
  let out = "";
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

// Feed an SSE payload split at an arbitrary byte offset across two chunks.
async function pipeSseSplit(input: string, at: number): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, at));
      controller.enqueue(bytes.slice(at));
      controller.close();
    },
  }).pipeThrough(createSseModelSwapStream(swap));
  let out = "";
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

describe("swapRequestModel (alias→real)", () => {
  it("rewrites the top-level model alias to the real id", () => {
    const out = swapRequestModel(JSON.stringify({ model: "appstrate-medium", messages: [] }), swap);
    expect(JSON.parse(out)).toEqual({ model: "deepseek-chat", messages: [] });
  });

  it("leaves a non-alias model untouched", () => {
    const body = JSON.stringify({ model: "gpt-4o", messages: [] });
    expect(swapRequestModel(body, swap)).toBe(body);
  });

  it("passes non-JSON through unchanged", () => {
    expect(swapRequestModel("not json", swap)).toBe("not json");
  });
});

describe("swapResponseModelJson (real→alias)", () => {
  it("rewrites OpenAI top-level model", () => {
    const out = swapResponseModelJson(
      JSON.stringify({ id: "x", model: "deepseek-chat", choices: [] }),
      swap,
    );
    expect(JSON.parse(out).model).toBe("appstrate-medium");
  });

  it("rewrites Anthropic top-level Message model", () => {
    const out = swapResponseModelJson(
      JSON.stringify({ type: "message", model: "deepseek-chat", content: [] }),
      swap,
    );
    expect(JSON.parse(out).model).toBe("appstrate-medium");
  });

  it("also rewrites a nested response.model in a JSON body (defensive; live nesting is the SSE path)", () => {
    const out = swapResponseModelJson(
      JSON.stringify({ id: "resp_1", object: "response", response: { model: "deepseek-chat" } }),
      swap,
    );
    expect(JSON.parse(out).response.model).toBe("appstrate-medium");
  });

  it("does NOT clobber the real id when it appears inside content text", () => {
    const out = swapResponseModelJson(
      JSON.stringify({
        model: "deepseek-chat",
        choices: [{ message: { content: "I am deepseek-chat under the hood" } }],
      }),
      swap,
    );
    const parsed = JSON.parse(out);
    expect(parsed.model).toBe("appstrate-medium");
    // The mention inside content survives verbatim — only the field was swapped.
    expect(parsed.choices[0].message.content).toBe("I am deepseek-chat under the hood");
  });
});

describe("createSseModelSwapStream (real→alias, streaming)", () => {
  it("rewrites model in OpenAI chunks and passes [DONE] through", async () => {
    const input =
      `data: {"object":"chat.completion.chunk","model":"deepseek-chat","choices":[]}\n\n` +
      `data: {"object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"delta":{"content":"hi"}}]}\n\n` +
      `data: [DONE]\n\n`;
    const out = await pipeSse(input);
    expect(out).not.toContain("deepseek-chat");
    expect(out.match(/"model":"appstrate-medium"/g)?.length).toBe(2);
    expect(out).toContain("data: [DONE]");
  });

  it("rewrites the nested model in an Anthropic message_start event", async () => {
    const input =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"id":"m","model":"deepseek-chat","content":[]}}\n\n` +
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n`;
    const out = await pipeSse(input);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain(`"model":"appstrate-medium"`);
    expect(out).toContain("event: message_start");
    expect(out).toContain("content_block_delta");
  });

  it("rewrites the nested response.model in OpenAI Responses streaming events", async () => {
    // The Responses API (codex / openai-responses) streams snapshots where the
    // model id sits at `response.model`, not top-level — must be swapped too.
    const input =
      `event: response.created\n` +
      `data: {"type":"response.created","response":{"id":"resp_1","model":"deepseek-chat"}}\n\n` +
      `event: response.output_text.delta\n` +
      `data: {"type":"response.output_text.delta","delta":"hi"}\n\n` +
      `event: response.completed\n` +
      `data: {"type":"response.completed","response":{"id":"resp_1","model":"deepseek-chat"}}\n\n`;
    const out = await pipeSse(input);
    expect(out).not.toContain("deepseek-chat");
    expect(out.match(/"model":"appstrate-medium"/g)?.length).toBe(2);
    expect(out).toContain("event: response.created");
    expect(out).toContain("response.output_text.delta");
  });

  it("rewrites correctly when a frame is split across chunk boundaries", async () => {
    const input = `data: {"object":"chat.completion.chunk","model":"deepseek-chat","choices":[]}\n\n`;
    // Split right in the middle of the JSON payload.
    const out = await pipeSseSplit(input, 40);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain(`"model":"appstrate-medium"`);
  });

  it("does not clobber the real id mentioned inside a content delta", async () => {
    const input = `data: {"choices":[{"delta":{"content":"deepseek-chat is great"}}]}\n\n`;
    const out = await pipeSse(input);
    // No model field here → the delta text is left exactly as-is.
    expect(out).toContain("deepseek-chat is great");
  });

  it("preserves a multi-byte UTF-8 char split across the chunk boundary", async () => {
    // Content holds an emoji + accented text; split the byte stream mid-codepoint
    // to prove the streaming TextDecoder reassembles it (claimed but unproven).
    const input = `data: {"model":"deepseek-chat","choices":[{"delta":{"content":"héllo 🚀 wörld"}}]}\n\n`;
    const bytes = new TextEncoder().encode(input);
    // The emoji starts a few bytes in; split inside its 4-byte sequence.
    const emojiByteIdx = bytes.indexOf(0xf0); // first byte of 🚀 (U+1F680)
    expect(emojiByteIdx).toBeGreaterThan(0);
    const out = await pipeSseSplit(input, emojiByteIdx + 2);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain(`"model":"appstrate-medium"`);
    expect(out).toContain("héllo 🚀 wörld");
  });

  it("rewrites a final frame that lacks a trailing newline (flush path)", async () => {
    // No trailing "\n\n" — the frame only reaches the client via flush().
    const input = `data: {"object":"chat.completion.chunk","model":"deepseek-chat","choices":[]}`;
    const out = await pipeSse(input);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain(`"model":"appstrate-medium"`);
  });

  it("matches the model by EXACT value, not substring (real=gpt-4 ≠ gpt-4o)", async () => {
    const narrow = { alias: "appstrate-small", real: "gpt-4" };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"model":"gpt-4o","choices":[]}\n\n`));
        controller.close();
      },
    }).pipeThrough(createSseModelSwapStream(narrow));
    let out = "";
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    // gpt-4o is a different model — must NOT be rewritten to the alias.
    expect(out).toContain(`"model":"gpt-4o"`);
    expect(out).not.toContain("appstrate-small");
  });
});

describe("scrubModelText (error-body blind scrub)", () => {
  it("replaces every real-id mention in free-form error prose", () => {
    const body = JSON.stringify({
      error: { message: "The model `deepseek-chat` does not exist (deepseek-chat)" },
    });
    const out = scrubModelText(body, swap);
    expect(out).not.toContain("deepseek-chat");
    expect(out.match(/appstrate-medium/g)?.length).toBe(2);
  });

  it("is a no-op when the body never mentions the real id", () => {
    const body = "upstream unavailable";
    expect(scrubModelText(body, swap)).toBe(body);
  });

  it("no-ops cleanly when alias === real", () => {
    const noop = { alias: "deepseek-chat", real: "deepseek-chat" };
    expect(scrubModelText("model deepseek-chat down", noop)).toBe("model deepseek-chat down");
  });
});

describe("isAliasableApiShape", () => {
  it("accepts body-model protocols (openai/anthropic/mistral)", () => {
    for (const s of [
      "openai-completions",
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "mistral-conversations",
    ] as const) {
      expect(isAliasableApiShape(s)).toBe(true);
    }
  });

  it("rejects url-model protocols (google/azure/bedrock)", () => {
    for (const s of [
      "google-generative-ai",
      "google-vertex",
      "azure-openai-responses",
      "bedrock-converse-stream",
    ] as const) {
      expect(isAliasableApiShape(s)).toBe(false);
    }
  });
});
