// SPDX-License-Identifier: Apache-2.0

/**
 * Invariant guard for the ai@7 cache-controlled system prompt.
 *
 * The chat's ai-sdk path delivers the system prompt through the canonical
 * `instructions` field as a `SystemModelMessage` object carrying the Anthropic
 * `cache_control` breakpoint in `providerOptions` (see `aiSdkCachedSystemMessage`)
 * — NOT as a bare string and NOT at the head of `messages`. ai@7 prepends
 * `instructions` to the model prompt as a `role:"system"` message, cacheControl
 * preserved, so the several-KB platform-MCP operation index stays cache-anchored
 * without the `allowSystemInMessages` compat flag.
 *
 * These tests drive the REAL `streamText` from ai@7 with a mock model through the
 * exact production assembly helpers and assert (a) the stream completes with no
 * error part, (b) the model received the system content FIRST, and (c) the
 * Anthropic `cacheControl` provider options are intact. The explicit
 * `providerOptions` assertion is the guard against a regression to a bare string
 * `instructions`, which would silently drop the cacheControl breakpoint.
 */

import { describe, expect, it } from "bun:test";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { CHAT_MAX_STEPS } from "@appstrate/core/chat-turn-metadata";
import { aiSdkCachedSystemMessage, prepareAiSdkChatStep } from "../src/chat-stream.ts";

// A stand-in for the real system prompt: large enough to make the point that it
// is the cached prefix, with a unique marker we can find in the model's prompt.
const SYSTEM_TEXT = `You are the Appstrate chat.\n${"OPERATION_INDEX_ENTRY ".repeat(64)}`;

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A one-shot text-only stream the mock returns for a step. */
function textStream(text: string): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  return {
    stream: simulateReadableStream<LanguageModelV3StreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop" }, usage: ZERO_USAGE },
      ],
    }),
  };
}

/** The system message the model recorded on a given `doStream` invocation. */
function recordedSystemMessage(model: MockLanguageModelV3, call = 0) {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return prompt.find((m) => m.role === "system") as
    { role: "system"; content: string; providerOptions?: Record<string, unknown> } | undefined;
}

const EPHEMERAL_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

describe("ai@7 cache-controlled instructions", () => {
  it("streams to completion and delivers the cached system message to the model (main call site)", async () => {
    const modelMessages = await convertToModelMessages([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ] satisfies UIMessage[]);

    const model = new MockLanguageModelV3({ doStream: async () => textStream("hi there") });

    // The exact production assembly: instructions object + plain messages.
    const result = streamText({
      model,
      instructions: aiSdkCachedSystemMessage(SYSTEM_TEXT),
      messages: modelMessages,
    });

    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part as LanguageModelV3StreamPart);

    // (a) No error part.
    expect(parts.filter((p) => p.type === "error")).toEqual([]);

    // The model was actually called.
    expect(model.doStreamCalls.length).toBe(1);

    // (b) The system message is FIRST in the model prompt (ai@7 prepends
    // instructions).
    expect(model.doStreamCalls[0]?.prompt[0]?.role).toBe("system");

    // (c) The system content reached the model with the anthropic cacheControl
    // provider options intact — the guard against a bare-string regression.
    const system = recordedSystemMessage(model);
    expect(system?.content).toBe(SYSTEM_TEXT);
    expect(system?.providerOptions).toEqual(EPHEMERAL_CACHE);
  });

  it("delivers the final-step (prepareStep) instructions override with cacheControl intact", async () => {
    const modelMessages = await convertToModelMessages([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ] satisfies UIMessage[]);

    // The final-step path swaps in its own cache-controlled instructions object
    // (the base prompt plus the appended final-step directive) and resets
    // `messages` to the original history.
    const prepared = prepareAiSdkChatStep({
      stepNumber: CHAT_MAX_STEPS - 1,
      system: SYSTEM_TEXT,
      modelMessages,
      markToolStepBudgetReached: () => {},
    });
    expect(prepared).toBeDefined();

    const model = new MockLanguageModelV3({ doStream: async () => textStream("done") });

    const result = streamText({
      model,
      instructions: prepared!.instructions,
      messages: prepared!.messages,
      toolChoice: prepared!.toolChoice,
    });

    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part as LanguageModelV3StreamPart);

    expect(parts.filter((p) => p.type === "error")).toEqual([]);
    expect(model.doStreamCalls.length).toBe(1);
    expect(model.doStreamCalls[0]?.prompt[0]?.role).toBe("system");

    const system = recordedSystemMessage(model);
    // The final-step system message carries the base prompt (plus the appended
    // final-step instruction) and the same cacheControl breakpoint.
    expect(system?.content).toContain(SYSTEM_TEXT);
    expect(system?.providerOptions).toEqual(EPHEMERAL_CACHE);
  });
});
