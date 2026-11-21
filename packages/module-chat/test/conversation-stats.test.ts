// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/conversation-stats.ts` — a conversation's record from its turn metadata. A message the
 * engine did not close (a user message, a turn cut before its finish) names no model.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { mergeTurnMetadata, type AppstrateTurnMetadata } from "@appstrate/core/chat-turn-metadata";
import { conversationStats } from "../src/ui/conversation-stats.ts";

function assistant(
  id: string,
  model: { id: string; label: string },
  extra: Partial<AppstrateTurnMetadata> = {},
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
      modelId: model.id,
      modelLabel: model.label,
      ...extra,
    }),
  } as UIMessage;
}

const user = (id: string) =>
  ({ id, role: "user", parts: [{ type: "text", text: "hi" }] }) as UIMessage;
const unclosed = (id: string) =>
  ({ id, role: "assistant", parts: [{ type: "text", text: "…" }] }) as UIMessage;

const FLASH = { id: "mdl_flash", label: "DeepSeek V4.1 Flash" };
const OPUS = { id: "mdl_opus", label: "Claude Opus 5" };
const FAILED = { finishReason: "error", errorCategory: "credential_unavailable" } as const;

describe("conversationStats", () => {
  it("reads an empty record from a conversation no turn closed", () => {
    expect(conversationStats([user("u1"), unclosed("a1")])).toEqual({ models: [], context: null });
  });

  it("counts turns per model in order of first use, its failed ones apart", () => {
    const stats = conversationStats([
      assistant("a1", FLASH),
      assistant("a2", OPUS, FAILED),
      assistant("a3", FLASH),
    ]);
    expect(stats.models).toEqual([
      { modelId: "mdl_flash", label: "DeepSeek V4.1 Flash", turns: 2, failed: 0 },
      { modelId: "mdl_opus", label: "Claude Opus 5", turns: 1, failed: 1 },
    ]);
  });

  it("names a model by the label its newest turn froze", () => {
    const stats = conversationStats([
      assistant("a1", { id: "mdl_x", label: "Ancien nom" }),
      assistant("a2", { id: "mdl_x", label: "Nouveau nom" }),
    ]);
    expect(stats.models[0]?.label).toBe("Nouveau nom");
  });

  it("reads the newest measured context", () => {
    const stats = conversationStats([
      assistant("a1", FLASH, {
        context: { tokens: 40_000, window: 1_000_000, compactAt: 600_000 },
      }),
      assistant("a2", FLASH),
    ]);
    expect(stats.context).toMatchObject({ tokens: 40_000, level: "ok" });
  });
});
