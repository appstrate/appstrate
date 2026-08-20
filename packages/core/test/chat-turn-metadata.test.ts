// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  formatTurnBudgetNote,
  CHAT_MAX_STEPS,
  CHAT_MIN_RUN_BUDGET_MS,
  CHAT_TOOL_STEP_BUDGET,
  CHAT_TURN_DEADLINE_MS,
  CHAT_TURN_SAFETY_MARGIN_MS,
  computeTurnRunBudget,
  formatBudgetDuration,
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
          finishReason: "stop",
          stepCount: 16,
          maxSteps: 16,
          maxStepsReached: true,
          lastToolName: "describe_operation",
        },
      },
    });
  });

  it("decodes a row still carrying the retired `engine` stamp", () => {
    // Threads persisted before the chat unified on one engine carry an `engine`
    // key the decoder no longer looks at. This is what let the field be dropped
    // without rewriting or deleting a single row: an unread extra key rides
    // along harmlessly. Forged as the STORED shape — `mergeTurnMetadata` cannot
    // express it any more, which is the point.
    const turn = {
      finishReason: "stop" as const,
      stepCount: 1,
      maxSteps: 16,
      maxStepsReached: false,
    };
    for (const engine of ["ai-sdk", "subscription", "pi"]) {
      const decoded = turnMetadataFromMessage({
        metadata: { appstrate: { turn: { engine, ...turn } } },
      });
      expect(decoded).toMatchObject({ finishReason: "stop", stepCount: 1 });
    }
    // And a row written today, with no stamp at all, decodes the same way.
    expect(turnMetadataFromMessage({ metadata: mergeTurnMetadata(undefined, turn) })).toMatchObject(
      { finishReason: "stop", stepCount: 1 },
    );
  });

  it("detects a reached tool-step budget as a turn limit", () => {
    const message = {
      role: "assistant",
      parts: [],
      metadata: mergeTurnMetadata(
        { source: "test" },
        {
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

  it("keeps a child call's budget strictly inside the turn that hosts it", () => {
    // The defect: RUN_AND_WAIT_MAX_MS (30 min) was three times the turn ceiling.
    expect(CHAT_TURN_DEADLINE_MS).toBe(10 * 60_000);
    const now = 1_800_000_000_000;
    const budget = computeTurnRunBudget(now + CHAT_TURN_DEADLINE_MS, now);
    expect(budget.maxMs).toBeLessThan(CHAT_TURN_DEADLINE_MS);
    expect(budget.maxMs).toBe(CHAT_TURN_DEADLINE_MS - CHAT_TURN_SAFETY_MARGIN_MS);
    // A launch is refused once the derived budget drops under the floor.
    expect(computeTurnRunBudget(now + CHAT_MIN_RUN_BUDGET_MS, now).launchable).toBe(false);
  });

  it("formats budget durations compactly", () => {
    expect(formatBudgetDuration(0)).toBe("0s");
    expect(formatBudgetDuration(-5_000)).toBe("0s");
    expect(formatBudgetDuration(22_400)).toBe("22s");
    expect(formatBudgetDuration(60_000)).toBe("1m00s");
    expect(formatBudgetDuration(4 * 60_000 + 12_000)).toBe("4m12s");
  });

  it("ignores malformed metadata", () => {
    expect(turnMetadataFromMessage({ metadata: { appstrate: { turn: { stepCount: 1 } } } })).toBe(
      null,
    );
    expect(turnLimitReached({ metadata: { appstrate: { turn: { stepCount: 1 } } } })).toBe(false);
  });
});

describe("budget note ↔ gate consistency", () => {
  // The note tells the model when a launch is possible; the gate decides. If
  // they quote different numbers the model arbitrates on the wrong one, which
  // is worse than showing no number at all.
  it("advertises a threshold at which the gate actually launches", () => {
    const threshold = CHAT_MIN_RUN_BUDGET_MS + CHAT_TURN_SAFETY_MARGIN_MS;
    expect(computeTurnRunBudget(threshold, 0).launchable).toBe(true);
    expect(computeTurnRunBudget(threshold - 1, 0).launchable).toBe(false);

    const note = formatTurnBudgetNote({ remainingMs: threshold, stepsUsed: 1 });
    expect(note).toContain(formatBudgetDuration(threshold));
    // The bare floor must NOT be advertised as the launch threshold: at
    // 1m30s remaining the gate refuses, because the safety margin comes first.
    expect(computeTurnRunBudget(CHAT_MIN_RUN_BUDGET_MS, 0).launchable).toBe(false);
  });
});
