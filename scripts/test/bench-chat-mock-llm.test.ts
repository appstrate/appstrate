// SPDX-License-Identifier: Apache-2.0

/**
 * The chat bench's mock upstream holds the model constant so two platform
 * builds differ only by the platform. That holds if its timing follows the
 * profile, its stream is one an OpenAI-compatible client accepts to the end
 * (usage frame included), and what it records is what the platform sent.
 */

import { afterEach, describe, it, expect } from "bun:test";
import { startMockLlm, type MockLlm, type MockProfile } from "../bench/chat/mock-llm.ts";

const PROFILE: MockProfile = {
  ttfbMs: 0,
  reasoningMsByEffort: { none: 0, low: 100, high: 400 },
  textTokens: 5,
  tokensPerSecond: 50,
};
const FRAME_MS = 1000 / PROFILE.tokensPerSecond;

let mock: MockLlm | null = null;
afterEach(() => {
  mock?.stop();
  mock = null;
});

interface Chunk {
  choices: {
    delta: { content?: string; reasoning_content?: string };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details: { reasoning_tokens: number };
  };
}

async function complete(
  body: Record<string, unknown>,
): Promise<{ chunks: Chunk[]; done: boolean }> {
  mock ??= startMockLlm(PROFILE);
  const res = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bench-model", stream: true, messages: [], ...body }),
  });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const events = (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((event) => event.replace(/^data: /, ""));
  return {
    chunks: events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e) as Chunk),
    done: events.at(-1) === "[DONE]",
  };
}

const reasoningFrames = (chunks: Chunk[]) =>
  chunks.filter((c) => c.choices[0]!.delta.reasoning_content !== undefined).length;

describe("startMockLlm", () => {
  it("reasons for the duration keyed by the reasoning_effort sent", async () => {
    const low = await complete({ reasoning_effort: "low" });
    const high = await complete({ reasoning_effort: "high" });
    const none = await complete({});
    expect(reasoningFrames(low.chunks)).toBe(100 / FRAME_MS);
    expect(reasoningFrames(high.chunks)).toBe(400 / FRAME_MS);
    expect(reasoningFrames(none.chunks)).toBe(0);
    // An effort the profile does not list reasons for nothing, not for a default.
    expect(reasoningFrames((await complete({ reasoning_effort: "xhigh" })).chunks)).toBe(0);

    const [lowRecord, highRecord] = mock!.records;
    const reasoningMs = (r: typeof lowRecord) => r!.firstContentAt! - r!.firstReasoningAt!;
    // Frames are paced by timers: a lower bound holds, an upper one would be flaky.
    expect(reasoningMs(lowRecord)).toBeGreaterThanOrEqual(100 - FRAME_MS);
    expect(reasoningMs(highRecord)).toBeGreaterThanOrEqual(400 - FRAME_MS);
    expect(mock!.records[2]!.firstReasoningAt).toBeNull();
  });

  it("streams the answer, then a usage frame and [DONE]", async () => {
    const { chunks, done } = await complete({ reasoning_effort: "low" });
    const text = chunks.map((c) => c.choices[0]!.delta.content ?? "").join("");
    expect(text).toBe("lorem ".repeat(PROFILE.textTokens));
    const last = chunks.at(-1)!;
    expect(last.choices[0]!.finish_reason).toBe("stop");
    const frames = 100 / FRAME_MS;
    expect(last.usage).toMatchObject({
      completion_tokens: frames + PROFILE.textTokens,
      completion_tokens_details: { reasoning_tokens: frames },
    });
    expect(last.usage!.total_tokens).toBe(
      last.usage!.prompt_tokens + last.usage!.completion_tokens,
    );
    expect(done).toBe(true);
  });

  it("keeps one `lorem` per answer token in markdown, which the ui scenario counts", async () => {
    mock = startMockLlm({ ...PROFILE, textTokens: 100, tokensPerSecond: 1000, markdown: true });
    const { chunks } = await complete({});
    const text = chunks.map((c) => c.choices[0]!.delta.content ?? "").join("");
    expect(text.split("lorem").length - 1).toBe(100);
    expect(text).toContain("\n\n- lorem ");
    expect(text).toContain("\n\nlorem ");
  });

  it("records what the platform sent", async () => {
    const body = {
      reasoning_effort: "high",
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: "é" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "a" } }],
    };
    const before = performance.timeOrigin + performance.now();
    await complete(body);
    const record = mock!.records[0]!;
    expect(record.receivedAt).toBeGreaterThanOrEqual(before);
    expect(record).toMatchObject({
      reasoningEffort: "high",
      maxTokens: 4096,
      messageCount: 2,
      toolCount: 1,
    });
    // Bytes, not characters: `é` is two bytes in UTF-8.
    const sent = JSON.stringify({ model: "bench-model", stream: true, ...body });
    expect(record.bodyBytes).toBe(new TextEncoder().encode(sent).byteLength);
    expect(record.bodyBytes).toBe(sent.length + 1);

    await complete({ max_tokens: 256 });
    expect(mock!.records[1]).toMatchObject({ reasoningEffort: null, maxTokens: 256, toolCount: 0 });
  });

  it("answers 404 off the completions route", async () => {
    mock = startMockLlm(PROFILE);
    expect((await fetch(`${mock.url}/v1/models`)).status).toBe(404);
  });
});
