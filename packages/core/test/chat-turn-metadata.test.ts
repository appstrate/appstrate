// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  appendFinalStepSystemPrompt,
  CHAT_FINAL_STEP_SYSTEM_PROMPT,
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
  isFinalChatStep,
  mergeTurnMetadata,
  turnLimitReached,
  turnMetadataFromMessage,
} from "../src/chat-turn-metadata.ts";

describe("chat turn metadata", () => {
  it("merges appstrate turn metadata without dropping existing message metadata", () => {
    const metadata = mergeTurnMetadata(
      { usage: { input_tokens: 10 }, costUsd: 0.01 },
      {
        engine: "subscription",
        finishReason: "stop",
        stepCount: 16,
        maxSteps: 16,
        maxStepsReached: true,
        lastToolName: "describe_operation",
      },
    );

    expect(metadata).toEqual({
      usage: { input_tokens: 10 },
      costUsd: 0.01,
      appstrate: {
        turn: {
          engine: "subscription",
          finishReason: "stop",
          stepCount: 16,
          maxSteps: 16,
          maxStepsReached: true,
          lastToolName: "describe_operation",
        },
      },
    });
  });

  it("detects a reached tool-step budget as a turn limit", () => {
    const message = {
      role: "assistant",
      parts: [],
      metadata: mergeTurnMetadata(
        { source: "test" },
        {
          engine: "ai-sdk",
          finishReason: "stop",
          stepCount: 16,
          maxSteps: 16,
          toolStepBudget: 15,
          toolStepBudgetReached: true,
          maxStepsReached: true,
        },
      ),
    };

    expect(turnLimitReached(message)).toBe(true);
    expect(turnMetadataFromMessage(message)?.toolStepBudget).toBe(15);
    expect(message.metadata.source).toBe("test");
  });

  it("reads assistant-ui message metadata from the top-level message", () => {
    const message = {
      role: "assistant",
      content: [],
      metadata: mergeTurnMetadata(undefined, {
        engine: "ai-sdk",
        finishReason: "stop",
        stepCount: 16,
        maxSteps: 16,
        toolStepBudget: 15,
        toolStepBudgetReached: true,
        maxStepsReached: true,
      }),
    };

    expect(turnLimitReached(message)).toBe(true);
    expect(turnLimitReached(message.content)).toBe(false);
  });

  it("recognizes the final reserved step by zero-based step number", () => {
    expect(CHAT_MAX_STEPS).toBe(16);
    expect(CHAT_TOOL_STEP_BUDGET).toBe(15);
    expect(isFinalChatStep(14)).toBe(false);
    expect(isFinalChatStep(15)).toBe(true);
    expect(isFinalChatStep(16)).toBe(true);
  });

  it("appends the final-step instruction to the existing system prompt", () => {
    expect(appendFinalStepSystemPrompt("Base")).toBe(`Base\n\n${CHAT_FINAL_STEP_SYSTEM_PROMPT}`);
  });

  it("ignores malformed metadata", () => {
    expect(turnMetadataFromMessage({ metadata: { appstrate: { turn: { stepCount: 1 } } } })).toBe(
      null,
    );
    expect(turnLimitReached({ metadata: { appstrate: { turn: { stepCount: 1 } } } })).toBe(false);
  });
});
