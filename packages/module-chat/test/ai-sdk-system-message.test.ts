// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the ai@7 cache-controlled system-message prompt.
 *
 * The chat's ai-sdk path deliberately rides the system prompt as a
 * `role:"system"` MESSAGE at the head of `messages` (not the `instructions`/
 * `system` field) so Anthropic gets an explicit `cache_control` breakpoint on
 * the several-KB platform-MCP operation index (see `aiSdkSystemMessagePrompt`).
 *
 * ai@7.0.33's `streamText` runs the prompt through `standardizePrompt`, which
 * rejects a system message inside `messages` unless `allowSystemInMessages` is
 * set — every turn died at `start → error → [DONE]` before any model call. The
 * fix pairs the message with that flag inside `aiSdkSystemMessagePrompt`, and
 * because `streamText` re-standardizes EVERY step the single top-level flag also
 * covers `prepareStep`'s final-step messages.
 *
 * These tests drive the REAL `streamText` from ai@7 with a mock model through
 * the exact production assembly helpers and assert (a) the stream completes with
 * no error part and (b) the model received the system content with the Anthropic
 * `cacheControl` provider options intact. On the pre-fix code (no
 * `allowSystemInMessages`) `standardizePrompt` throws before the model is ever
 * called, so the model records zero calls and the stream emits an error part —
 * both assertions fail.
 */

import { describe, expect, it } from "bun:test";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { CHAT_MAX_STEPS } from "@appstrate/core/chat-turn-metadata";
import { aiSdkSystemMessagePrompt, prepareAiSdkChatStep } from "../src/chat-stream.ts";

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

describe("ai@7 cache-controlled system message prompt", () => {
  it("streams to completion and delivers the cached system message to the model (main call site)", async () => {
    const modelMessages = await convertToModelMessages([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ] satisfies UIMessage[]);

    const model = new MockLanguageModelV3({ doStream: async () => textStream("hi there") });

    // The exact production assembly: message pattern + `allowSystemInMessages`.
    const result = streamText({ model, ...aiSdkSystemMessagePrompt(SYSTEM_TEXT, modelMessages) });

    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part as LanguageModelV3StreamPart);

    // (a) No error part — the pre-fix bug surfaced exactly here.
    expect(parts.filter((p) => p.type === "error")).toEqual([]);

    // The model was actually called (pre-fix: standardizePrompt throws first → 0).
    expect(model.doStreamCalls.length).toBe(1);

    // (b) The system content reached the model with the anthropic cacheControl
    // provider options intact.
    const system = recordedSystemMessage(model);
    expect(system?.content).toBe(SYSTEM_TEXT);
    expect(system?.providerOptions).toEqual(EPHEMERAL_CACHE);
  });

  it("keeps the final-step (prepareStep) messages legal under the same top-level flag", async () => {
    const modelMessages = await convertToModelMessages([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ] satisfies UIMessage[]);

    // The final-step path returns its own cache-controlled system message inside
    // `messages`; it depends on the flag set on the top-level streamText call.
    // Read the flag from the single source of truth so removing it breaks this
    // test too.
    const { allowSystemInMessages } = aiSdkSystemMessagePrompt(SYSTEM_TEXT, modelMessages);
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
      allowSystemInMessages,
      messages: prepared!.messages,
      toolChoice: prepared!.toolChoice,
    });

    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part as LanguageModelV3StreamPart);

    expect(parts.filter((p) => p.type === "error")).toEqual([]);
    expect(model.doStreamCalls.length).toBe(1);

    const system = recordedSystemMessage(model);
    // The final-step system message carries the base prompt (plus the appended
    // final-step instruction) and the same cacheControl breakpoint.
    expect(system?.content).toContain(SYSTEM_TEXT);
    expect(system?.providerOptions).toEqual(EPHEMERAL_CACHE);
  });
});
