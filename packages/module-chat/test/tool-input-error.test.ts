// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the deleted tool-call input repair layer.
 *
 * The chat stream used to wire `experimental_repairToolCall` to unwrap
 * double-encoded / stringified tool inputs. That tolerance is gone: the AI SDK
 * has a native loop where an unparseable/schema-invalid tool input becomes an
 * `invalid: true` tool call carrying the error, surfaced to the model on the
 * next step so it can self-correct. This test proves that malformed input does
 * NOT crash `streamText` and that the error is fed back to the model — without
 * any repair function configured.
 */

import { describe, expect, it } from "bun:test";
import { dynamicTool, jsonSchema, isStepCount, streamText } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";

// The two malformed shapes the deleted repair layer was built to tolerate:
//   1. A JSON object string with a LITERAL newline inside a string value —
//      invalid JSON (control chars must be escaped), fails at JSON.parse.
//   2. `JSON.stringify(JSON.stringify({...}))` — valid JSON whose parsed value
//      is a *string*, not the object the tool schema requires.
const LITERAL_NEWLINE_INPUT = '{"kind":"inline","prompt":"Step 1\nStep 2"}';
const DOUBLE_ENCODED_INPUT = JSON.stringify(
  JSON.stringify({ kind: "inline", prompt: "Do the work" }),
);

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function toolCallPart(toolCallId: string, input: string): LanguageModelV3StreamPart {
  return { type: "tool-call", toolCallId, toolName: "dummy", input, dynamic: true };
}

function stream(chunks: LanguageModelV3StreamPart[]) {
  return {
    stream: simulateReadableStream({
      chunks: [{ type: "stream-start" as const, warnings: [] }, ...chunks],
    }),
  };
}

describe("malformed tool input (no repair layer)", () => {
  it("surfaces an invalid tool call to the model instead of crashing the stream", async () => {
    let executed = false;

    const dummy = dynamicTool({
      description: "A dummy tool that requires a well-formed object input.",
      inputSchema: jsonSchema<{ kind: string; prompt: string }>(
        {
          type: "object",
          properties: { kind: { type: "string" }, prompt: { type: "string" } },
          required: ["kind", "prompt"],
          additionalProperties: false,
        },
        {
          validate: (value) => {
            const v = value as { kind?: unknown; prompt?: unknown };
            return typeof value === "object" &&
              value !== null &&
              typeof v.kind === "string" &&
              typeof v.prompt === "string"
              ? { success: true, value: v as { kind: string; prompt: string } }
              : { success: false, error: new Error("input must be an object") };
          },
        },
      ),
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });

    // Step 1 emits two malformed tool calls; step 2 finishes with plain text.
    const model = new MockLanguageModelV3({
      doStream: async () => {
        const call = model.doStreamCalls.length; // 1 on the first invocation
        if (call === 1) {
          return stream([
            toolCallPart("call_newline", LITERAL_NEWLINE_INPUT),
            toolCallPart("call_double", DOUBLE_ENCODED_INPUT),
            { type: "finish", finishReason: { unified: "tool-calls" }, usage: ZERO_USAGE },
          ]);
        }
        return stream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Let me fix that." },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop" }, usage: ZERO_USAGE },
        ]);
      },
    });

    const result = streamText({
      model,
      tools: { dummy },
      messages: [{ role: "user", content: "call the dummy tool" }],
      stopWhen: isStepCount(2),
    });

    // Draining the whole stream must not throw despite the malformed inputs.
    await result.consumeStream();
    const steps = await result.steps;

    // The model was called a second time — i.e. the loop continued rather than
    // crashing on the malformed inputs.
    expect(model.doStreamCalls.length).toBe(2);
    expect(steps.length).toBe(2);

    // The tool never executed (input never validated).
    expect(executed).toBe(false);

    // Step 1 carries both tool calls flagged invalid, each with an error.
    const invalidCalls = steps[0].content.filter(
      (p) => p.type === "tool-call" && p.dynamic === true && p.invalid === true,
    );
    expect(invalidCalls.length).toBe(2);
    for (const part of invalidCalls) {
      expect((part as { error?: unknown }).error).toBeDefined();
    }

    // The error is surfaced to the model on the next step: the second inference
    // call's prompt includes tool messages describing the failed calls.
    const secondPrompt = model.doStreamCalls[1].prompt;
    const promptText = JSON.stringify(secondPrompt);
    expect(promptText).toContain("call_newline");
    expect(promptText).toContain("call_double");
    const hasToolMessage = secondPrompt.some((m) => m.role === "tool");
    expect(hasToolMessage).toBe(true);
  });
});
