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
import {
  mergeTurnMetadata,
  type AppstrateTurnContext,
  type AppstrateTurnSummary,
} from "@appstrate/core/chat-turn-metadata";
import {
  contextReading,
  latestConversationContext,
  thresholdShare,
} from "../src/ui/turn-context.ts";

function assistant(id: string, context?: unknown, summary?: AppstrateTurnSummary): UIMessage {
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
      ...(summary ? { summary } : {}),
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
      summarized: false,
      modelId: "mdl_opus",
      modelLabel: "Claude Opus 5",
    });
  });

  it("says the history is summarized once any turn summarized it, even one that measured nothing", () => {
    const summary = { text: "Résumé", keptFrom: { messageId: "u2", offset: 0 }, tokensBefore: 9 };
    const measure = { tokens: 10_000, window: 200_000, compactAt: 180_000 };
    const later = [assistant("a1", measure), user("u2"), assistant("a2", undefined, summary)];
    expect(latestConversationContext(later)).toMatchObject({ tokens: 10_000, summarized: true });
    expect(latestConversationContext([assistant("a1", measure, summary)])?.summarized).toBe(true);
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

  it("grades a turn that summarized by its tokens alone: the summary is not made again", () => {
    const summary = { text: "Résumé", keptFrom: { messageId: "u1", offset: 0 }, tokensBefore: 9 };
    const measure = (tokens: number) => ({ tokens, window: 1_000_000, compactAt: 600_000 });
    expect(latestConversationContext([assistant("a1", measure(40_000), summary)])).toMatchObject({
      level: "ok",
      summarized: true,
    });
    expect(latestConversationContext([assistant("a1", measure(600_001), summary)])?.level).toBe(
      "full",
    );
  });
});

describe("thresholdShare", () => {
  const share = (tokens: number) => thresholdShare({ tokens, compactAt: 100_000 });

  it("floors under the threshold, so just short of it never reads 100 %", () => {
    expect(share(99_600)).toBe(0.99);
    expect(share(100_000)).toBe(1);
  });

  it("is unclamped past the threshold, unlike the fill", () => {
    expect(share(150_000)).toBe(1.5);
    expect(contextReading({ tokens: 150_000, window: 200_000, compactAt: 100_000 }).ratio).toBe(1);
  });
});
