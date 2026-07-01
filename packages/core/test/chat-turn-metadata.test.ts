// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  mergeTurnMetadata,
  turnLimitReached,
  turnMetadataFromMessage,
  withTurnMetadata,
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
    const message = withTurnMetadata(
      { role: "assistant", parts: [], metadata: { source: "test" } },
      {
        engine: "ai-sdk",
        finishReason: "stop",
        stepCount: 16,
        maxSteps: 16,
        toolStepBudget: 15,
        toolStepBudgetReached: true,
        maxStepsReached: true,
      },
    );

    expect(turnLimitReached(message)).toBe(true);
    expect(turnMetadataFromMessage(message)?.toolStepBudget).toBe(15);
    expect(message.metadata.source).toBe("test");
  });

  it("ignores malformed metadata", () => {
    expect(turnMetadataFromMessage({ metadata: { appstrate: { turn: { stepCount: 1 } } } })).toBe(
      null,
    );
    expect(turnLimitReached({ metadata: { appstrate: { turn: { stepCount: 1 } } } })).toBe(false);
  });
});
