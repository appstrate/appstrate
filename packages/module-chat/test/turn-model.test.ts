// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/turn-model.ts` — reading back which model answered a turn.
 *
 * The cases that matter are the absent ones: a user message and a message the
 * engine did not close. Both must read as "no model", never as a default,
 * because the badge that consumes this renders whatever it is handed.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { mergeTurnMetadata } from "@appstrate/core/chat-turn-metadata";
import { latestTurnModelId, turnModelLabel } from "../src/ui/turn-model.ts";

/** An assistant message carrying the metadata `closePiTurn` stamps. */
function assistant(
  id: string,
  model?: { id: string; label: string },
  extra: Record<string, unknown> = {},
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "ok" }],
    metadata: mergeTurnMetadata(undefined, {
      finishReason: "stop",
      stepCount: 1,
      maxSteps: 16,
      maxStepsReached: false,
      ...(model ? { modelId: model.id, modelLabel: model.label } : {}),
      ...extra,
    }),
  } as UIMessage;
}

const OPUS = { id: "mdl_opus", label: "Claude Opus 5" };
const SONNET = { id: "mdl_sonnet", label: "Claude Sonnet 5" };

describe("reading a turn's model", () => {
  it("returns the id and the frozen label", () => {
    const message = assistant("a", OPUS);
    expect(latestTurnModelId([message])).toBe("mdl_opus");
    expect(turnModelLabel(message)).toBe("Claude Opus 5");
  });

  it("returns null for a turn that carries no model", () => {
    const message = assistant("a");
    expect(latestTurnModelId([message])).toBeNull();
    expect(turnModelLabel(message)).toBeNull();
  });

  it("returns null for a message with no turn metadata at all", () => {
    // Every user turn and every server-authored notice.
    const user = { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage;
    expect(latestTurnModelId([user])).toBeNull();
    expect(turnModelLabel(user)).toBeNull();
  });
});

describe("the model a conversation is on", () => {
  it("is the model of its NEWEST turn, not its first", () => {
    // The whole point: a conversation that switched models continues on the one
    // it switched to. Reading the first turn would re-seed the picker to a
    // model the user deliberately left.
    const messages = [assistant("a", OPUS), assistant("b", SONNET)];
    expect(latestTurnModelId(messages)).toBe("mdl_sonnet");
  });

  it("skips messages carrying no model instead of treating them as a reset", () => {
    // A server-authored notice lands between turns with the assistant role and
    // no metadata; it must not erase what the conversation is on.
    const notice = {
      id: "n",
      role: "assistant",
      parts: [{ type: "text", text: "your run finished" }],
    } as UIMessage;
    expect(latestTurnModelId([assistant("a", OPUS), notice])).toBe("mdl_opus");
  });

  it("is null for a conversation with no model anywhere", () => {
    expect(latestTurnModelId([])).toBeNull();
    expect(latestTurnModelId([assistant("a")])).toBeNull();
  });
});
