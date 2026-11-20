// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/turn-context.ts` — reading back how full a conversation's context is.
 *
 * The absent cases matter as much as the levels: a conversation no turn
 * measured must read as "nothing to show", never as an empty gauge, because a
 * zero would claim a measurement that never happened.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { mergeTurnMetadata, type AppstrateTurnContext } from "@appstrate/core/chat-turn-metadata";
import { contextReading, latestConversationContext } from "../src/ui/turn-context.ts";

function assistant(id: string, context?: unknown): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "ok" }],
    metadata: mergeTurnMetadata(undefined, {
      finishReason: "stop",
      stepCount: 1,
      maxSteps: 16,
      maxStepsReached: false,
      modelId: "mdl_opus",
      modelLabel: "Claude Opus 5",
      ...(context === undefined ? {} : { context: context as AppstrateTurnContext }),
    }),
  } as UIMessage;
}

const user = (id: string) =>
  ({ id, role: "user", parts: [{ type: "text", text: "hi" }] }) as UIMessage;

describe("latestConversationContext", () => {
  it("reads nothing from a conversation no turn measured", () => {
    expect(latestConversationContext([])).toBeNull();
    expect(latestConversationContext([user("u1"), assistant("a1")])).toBeNull();
  });

  it("reads the newest measure, skipping a turn still open", () => {
    const messages = [
      assistant("a1", { tokens: 10_000, window: 200_000, compactAt: 183_616 }),
      user("u2"),
      assistant("a2", { tokens: 42_000, window: 200_000, compactAt: 183_616 }),
      user("u3"),
      assistant("a3"),
    ];
    expect(latestConversationContext(messages)).toMatchObject({
      tokens: 42_000,
      window: 200_000,
      ratio: 0.21,
      level: "ok",
      modelId: "mdl_opus",
      modelLabel: "Claude Opus 5",
    });
  });

  it("skips a malformed measure instead of dividing by it", () => {
    const messages = [
      assistant("a1", { tokens: 5, window: 100 }),
      assistant("a2", { tokens: 5, window: 0 }),
      assistant("a3", { tokens: "5", window: 100 }),
    ];
    expect(latestConversationContext(messages)?.tokens).toBe(5);
    expect(latestConversationContext(messages)?.window).toBe(100);
  });
});

describe("contextReading", () => {
  it("warns from 80% of the compaction threshold, not of the window", () => {
    expect(contextReading({ tokens: 140_000, window: 200_000, compactAt: 180_000 }).level).toBe(
      "ok",
    );
    expect(contextReading({ tokens: 144_000, window: 200_000, compactAt: 180_000 }).level).toBe(
      "near",
    );
    expect(contextReading({ tokens: 180_000, window: 200_000, compactAt: 180_000 }).level).toBe(
      "full",
    );
  });

  it("measures against the window when compaction is off", () => {
    expect(contextReading({ tokens: 159_000, window: 200_000 }).level).toBe("ok");
    expect(contextReading({ tokens: 160_000, window: 200_000 }).level).toBe("near");
  });

  it("clamps the ratio to the window", () => {
    expect(contextReading({ tokens: 250_000, window: 200_000 }).ratio).toBe(1);
  });
});
