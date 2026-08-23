// SPDX-License-Identifier: Apache-2.0

/**
 * The response-side `model` rewrite (real→alias) for non-stream JSON AND
 * streaming SSE (OpenAI top-level + Anthropic `message_start` nesting), the
 * alias-refusal envelope, and the boot-time descriptor parse. The hard
 * invariant on the rewrite: a model id mentioned inside generated content is
 * NEVER clobbered (match by value at known paths, not a blind string replace).
 */

import { describe, it, expect } from "bun:test";
// The response rewrite is core-only now (the sidecar terminates rather than
// proxies); the sidecar re-exports only what it still calls.
import { swapResponseModelJson, createSseModelSwapStream } from "@appstrate/core/model-swap";
import { syntheticAliasErrorBody, isAliasBackingShape, parseModelSwapEnv } from "../model-swap.ts";

const swap = {
  alias: "appstrate-medium",
  real: "deepseek-chat",
  clientApiShape: "openai-completions" as const,
  backingApiShape: "openai-completions" as const,
};

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
    const narrow = {
      alias: "appstrate-small",
      real: "gpt-4",
      clientApiShape: "openai-completions" as const,
      backingApiShape: "openai-completions" as const,
    };
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

  it("replaces an Anthropic error frame with the synthetic envelope", async () => {
    const input = `data: {"type":"error","error":{"type":"overloaded_error","message":"model deepseek-chat is overloaded"}}\n\n`;
    const out = await pipeSse(input);
    // Nothing from the upstream frame survives — not the id, not the prose.
    expect(out).not.toContain("deepseek-chat");
    expect(out).not.toContain("overloaded");
    expect(out).toContain("appstrate-medium");
    expect(out).toContain("upstream_error");
  });

  it("replaces an OpenAI-family standalone error frame with the synthetic envelope", async () => {
    const input = `data: {"error":{"message":"deepseek-chat quota exceeded","code":429}}\n\n`;
    const out = await pipeSse(input);
    expect(out).not.toContain("deepseek-chat");
    expect(out).not.toContain("quota");
    expect(out).toContain("appstrate-medium");
    expect(out).toContain("upstream_error");
  });

  it("replaces an OpenAI Responses terminal-failure frame (nested response.error)", async () => {
    // `response.failed` / `response.incomplete` nest the error one level down —
    // the prose there names the backing just like a top-level error frame.
    const input =
      `event: response.failed\n` +
      `data: {"type":"response.failed","response":{"model":"deepseek-chat","error":{"code":"server_error","message":"deepseek-chat unavailable at api.deepseek.com"}}}\n\n`;
    const out = await pipeSse(input);
    expect(out).not.toContain("deepseek");
    expect(out).toContain("appstrate-medium");
    expect(out).toContain("upstream_error");
  });

  it("does NOT replace a response snapshot whose error is null (success case)", async () => {
    const input = `data: {"type":"response.completed","response":{"model":"deepseek-chat","error":null,"usage":{"total_tokens":5}}}\n\n`;
    const out = await pipeSse(input);
    expect(out).toContain(`"model":"appstrate-medium"`);
    expect(out).toContain("total_tokens");
    expect(out).not.toContain("upstream_error");
  });

  it("keeps content-delta prose intact — only the model field is rewritten", async () => {
    const input = `data: {"model":"deepseek-chat","choices":[{"delta":{"content":"I am deepseek-chat"}}]}\n\n`;
    const out = await pipeSse(input);
    expect(out).toContain(`"model":"appstrate-medium"`);
    expect(out).toContain("I am deepseek-chat");
  });

  it("does NOT replace a hybrid frame carrying both an error object and choices content", async () => {
    // A frame with generated content is never replaced wholesale — the
    // `choices` guard keeps it on the exact-field rewrite path.
    const input = `data: {"model":"deepseek-chat","error":{"message":"partial failure"},"choices":[{"delta":{"content":"kept text"}}]}\n\n`;
    const out = await pipeSse(input);
    expect(out).toContain("kept text");
    expect(out).toContain(`"model":"appstrate-medium"`);
    expect(out).not.toContain("upstream_error");
  });
});

describe("syntheticAliasErrorBody", () => {
  it("names the alias and the neutral message, never the real id", () => {
    const out = syntheticAliasErrorBody(swap);
    expect(out).toContain("appstrate-medium");
    expect(out).toContain("Upstream model error");
    expect(out).not.toContain("deepseek-chat");
  });

  it("includes the upstream status when given", () => {
    expect(syntheticAliasErrorBody(swap, 429)).toContain("429");
  });

  it("parses as a JSON error envelope (type + error.message)", () => {
    const parsed = JSON.parse(syntheticAliasErrorBody(swap, 503));
    expect(parsed.type).toBe("error");
    expect(typeof parsed.error.message).toBe("string");
  });
});

describe("isAliasBackingShape", () => {
  it("accepts body-model protocols (openai/anthropic/mistral)", () => {
    for (const s of [
      "openai-completions",
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "mistral-conversations",
    ] as const) {
      expect(isAliasBackingShape(s)).toBe(true);
    }
  });

  it("rejects url-model protocols (google/azure/bedrock)", () => {
    for (const s of [
      "google-generative-ai",
      "google-vertex",
      "azure-openai-responses",
      "bedrock-converse-stream",
    ] as const) {
      expect(isAliasBackingShape(s)).toBe(false);
    }
  });

  it("rejects the client-only dialect (`pi-messages` is never a backing)", () => {
    expect(isAliasBackingShape("pi-messages")).toBe(false);
  });
});

/**
 * `parseModelSwapEnv` — the process boundary the swap descriptor actually
 * crosses (`PI_MODEL_SWAP_JSON`, read once in `server.ts` at boot). It used to
 * be a blind `as ModelSwap` cast, so a platform predating a protocol field produced a
 * swap that failed closed at request time: correct, but one opaque 404 per
 * inference attempt and no statement of the cause. The guard turns that into a
 * single boot failure naming the field — and never naming its value, because
 * these logs are operator-visible and the backing is what an alias hides.
 */
describe("parseModelSwapEnv", () => {
  // `as const` only so `toEqual` can compare against the `ModelSwap` the parser
  // returns; the parser itself receives these as raw JSON text.
  const wellFormed = {
    alias: "appstrate-medium",
    real: "deepseek-chat",
    clientApiShape: "pi-messages" as const,
    backingApiShape: "openai-completions" as const,
    backing: { providerId: "deepseek", reasoning: false, input: ["text"] },
  };

  it("accepts a well-formed descriptor", () => {
    expect(parseModelSwapEnv(JSON.stringify(wellFormed))).toEqual(wellFormed);
  });

  it("keeps the optional adaptive-reasoning correction", () => {
    const adaptive = {
      alias: "appstrate-adaptive",
      real: "claude-sonnet-4-6",
      clientApiShape: "pi-messages" as const,
      backingApiShape: "anthropic-messages" as const,
      backing: { providerId: "anthropic", reasoning: true, input: ["text"] },
      anthropicAdaptiveReasoning: { effort: "max" as const },
    };
    expect(parseModelSwapEnv(JSON.stringify(adaptive))).toEqual(adaptive);
  });

  it("keeps a re-origination descriptor whole", () => {
    // What an ALIASED run actually ships: the container speaks the canonical
    // dialect, the backing speaks the vendor's, and the catalog needed to
    // rebuild the backing's pi model rides on the same private descriptor.
    const reoriginating = {
      alias: "appstrate-medium",
      real: "deepseek-chat",
      clientApiShape: "pi-messages" as const,
      backingApiShape: "openai-completions" as const,
      backing: {
        providerId: "deepseek",
        reasoning: true,
        reasoningLevelMap: { high: "high" as const },
        input: ["text"],
      },
    };
    expect(parseModelSwapEnv(JSON.stringify(reoriginating))).toEqual(reoriginating);
  });

  it("rejects a descriptor with no protocol fields (the pre-#1198 platform payload)", () => {
    expect(() => parseModelSwapEnv(JSON.stringify({ alias: "a", real: "deepseek-chat" }))).toThrow(
      /"clientApiShape"/,
    );
  });

  it("rejects an unknown protocol on either side", () => {
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, clientApiShape: "openai-chat" })),
    ).toThrow(/"clientApiShape"/);
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, backingApiShape: "openai-chat" })),
    ).toThrow(/"backingApiShape"/);
  });

  it("rejects a known but non-aliasable protocol (url-model)", () => {
    // Every call would be refused anyway — say so at boot instead.
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, clientApiShape: "google-generative-ai" })),
    ).toThrow(/"clientApiShape"/);
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, backingApiShape: "google-generative-ai" })),
    ).toThrow(/"backingApiShape"/);
  });

  it("rejects the client dialect as a BACKING, at boot", () => {
    // `pi-messages` is what an aliased container speaks INTO the sidecar; the
    // sidecar has no stream to re-originate it against. Refusing it here is the
    // difference between one boot error and one throw per request, deep inside
    // the stream.
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, backingApiShape: "pi-messages" })),
    ).toThrow(/"backingApiShape"/);
  });

  it("rejects a vendor protocol as the CLIENT (the container speaks one dialect)", () => {
    for (const shape of ["anthropic-messages", "openai-completions"]) {
      expect(() =>
        parseModelSwapEnv(JSON.stringify({ ...wellFormed, clientApiShape: shape })),
      ).toThrow(/"clientApiShape"/);
    }
  });

  it("rejects a re-origination descriptor with no backing catalog", () => {
    // The pairing that cannot fail open: a boundary that must REBUILD the
    // backing's model record and has nothing to rebuild it from would throw
    // once per request, deep inside the stream, with no stated cause.
    const { backing: _drop, ...rest } = wellFormed;
    expect(() => parseModelSwapEnv(JSON.stringify(rest))).toThrow(/"backing"/);
  });

  it("rejects a re-origination descriptor whose backing catalog is incomplete", () => {
    const base = {
      alias: "appstrate-medium",
      real: "deepseek-chat",
      clientApiShape: "pi-messages" as const,
      backingApiShape: "openai-completions" as const,
    };
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({ ...base, backing: { reasoning: false, input: ["text"] } }),
      ),
    ).toThrow(/"backing.providerId"/);
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({ ...base, backing: { providerId: "deepseek", input: ["text"] } }),
      ),
    ).toThrow(/"backing.reasoning"/);
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({ ...base, backing: { providerId: "deepseek", reasoning: false } }),
      ),
    ).toThrow(/"backing.input"/);
  });

  it("rejects a missing or blank alias / real", () => {
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({
          real: "deepseek-chat",
          clientApiShape: "pi-messages",
          backingApiShape: "openai-completions",
        }),
      ),
    ).toThrow(/"alias"/);
    expect(() => parseModelSwapEnv(JSON.stringify({ ...wellFormed, real: "   " }))).toThrow(
      /"real"/,
    );
  });

  it("reports malformed JSON instead of crashing with a raw SyntaxError", () => {
    expect(() => parseModelSwapEnv("{not json")).toThrow(/not valid JSON/);
    expect(() => parseModelSwapEnv("[]")).toThrow(/expected a JSON object/);
    expect(() => parseModelSwapEnv("null")).toThrow(/expected a JSON object/);
  });

  it("never names the backing model in any message", () => {
    const cases = [
      JSON.stringify({ alias: "appstrate-medium", real: "deepseek-chat" }),
      JSON.stringify({ ...wellFormed, clientApiShape: "google-generative-ai" }),
      `{"real":"deepseek-chat",`,
    ];
    for (const raw of cases) {
      let message = "";
      try {
        parseModelSwapEnv(raw);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("deepseek");
      expect(message).not.toContain("google");
    }
  });
});
