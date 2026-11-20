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

  it("reads the newest measure, past a closed turn that measured nothing", () => {
    const messages = [
      assistant("a1", { tokens: 10_000, window: 200_000, compactAt: 180_000 }),
      user("u2"),
      assistant("a2", { tokens: 45_000, window: 200_000, compactAt: 180_000 }),
      user("u3"),
      assistant("a3"),
    ];
    expect(latestConversationContext(messages)).toMatchObject({
      tokens: 45_000,
      ratio: 0.25,
      level: "ok",
      modelId: "mdl_opus",
      modelLabel: "Claude Opus 5",
    });
  });
});

describe("contextReading", () => {
  const at = (tokens: number) => contextReading({ tokens, window: 1_000_000, compactAt: 600_000 });

  it("fills and grades on the summarizing threshold, not the window", () => {
    expect(at(300_000)).toEqual({ ratio: 0.5, level: "ok" });
    expect(at(480_000).level).toBe("near");
    // The engine summarizes past the threshold, not at it.
    expect(at(600_000)).toEqual({ ratio: 1, level: "near" });
    expect(at(600_001).level).toBe("full");
  });

  it("reads a turn that summarized the history as full: every later turn summarizes it again", () => {
    const summarized = { tokens: 40_000, window: 1_000_000, compactAt: 600_000, compacted: true };
    expect(contextReading(summarized)).toEqual({ ratio: 1, level: "full" });
  });
});
