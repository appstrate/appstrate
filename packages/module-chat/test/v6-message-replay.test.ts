// SPDX-License-Identifier: Apache-2.0

/**
 * v6-persisted-message replay guard.
 *
 * Chat persistence stores UIMessage JSON verbatim (`persistence.ts`, format
 * `ai-sdk/v6`); prod holds ~171 sessions written under AI SDK v6. On every turn
 * the load path projects that stored history into the engine's session
 * (`buildStructuredPiTurn`), so a shape the projection no longer accepts — or
 * silently drops — would corrupt the model's view of past turns and bypass the
 * connect-link redaction that rides every replayed tool result.
 *
 * These tests feed a realistic v6-shaped persisted assistant message (text,
 * reasoning, step-start, a static `tool-<name>` part and a `dynamic-tool` part,
 * both `output-available` with input+output) through the projection and assert
 * the replay: no throw, the tool calls and their results survive with their call
 * ids intact, and a `connect_url` persisted in a completed tool output is
 * redacted before the model can re-read it.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import type { Message } from "@appstrate/runner-pi";
import { buildStructuredPiTurn } from "../src/pi-chat/structured-session.ts";
import { REDACTED_CONNECT_LINK } from "../src/connect-offer.ts";

const MODEL = { api: "anthropic-messages", provider: "anthropic", model: "claude" } as const;

/** Token estimate is irrelevant here — the projection's SHAPE is under test. */
const OPTIONS = { estimateTokens: () => 1, baseTokens: 0 };

/**
 * A v6-persisted thread: a user turn, an assistant turn carrying every part kind
 * chat can persist — text, reasoning, a step boundary, a static tool call
 * (`tool-search_operations`) and a dynamic tool call (`dynamic-tool`), each in
 * the completed `output-available` shape (input + output) — then the new user
 * turn this projection is being built for. Ids match the wire shape
 * assistant-ui writes.
 */
function v6Thread(): UIMessage[] {
  return [
    { id: "m_user", role: "user", parts: [{ type: "text", text: "connect gmail" }] },
    {
      id: "m_asst",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "The user wants to connect Gmail." },
        { type: "text", text: "Let me look that up." },
        { type: "step-start" },
        {
          // Static tool part: `type: "tool-<name>"`, completed with input+output.
          type: "tool-search_operations",
          toolCallId: "call_static_1",
          state: "output-available",
          input: { query: "gmail connect" },
          // The connect_url in a completed tool output is what the replay must
          // scrub before the model sees the history again.
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  connect_url: "https://app/api/integrations/connect/start?token=t",
                }),
              },
            ],
          },
        } as never,
        {
          // Dynamic tool part: `type: "dynamic-tool"`, name carried on `toolName`.
          type: "dynamic-tool",
          toolName: "invoke_operation",
          toolCallId: "call_dynamic_1",
          state: "output-available",
          input: { operationId: "connectGmail" },
          output: { content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] },
        } as never,
      ],
    },
    { id: "m_user_2", role: "user", parts: [{ type: "text", text: "and now?" }] },
  ];
}

function toolResults(history: Message[]) {
  return history.filter((m): m is Extract<Message, { role: "toolResult" }> => {
    return m.role === "toolResult";
  });
}

describe("v6 message replay through the structured Pi projection", () => {
  it("replays a v6 thread without throwing and yields the expected role sequence", () => {
    const turn = buildStructuredPiTurn(v6Thread(), MODEL, OPTIONS);

    // The `step-start` part partitions the assistant turn: the text segment
    // first, then the tool-call segment followed by its two results — a
    // semantically faithful reading of the persisted turn.
    expect(turn.history.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    // The trailing user turn becomes the prompt, not history.
    expect(turn.prompt).toBe("and now?");
    expect(turn.branchHeadId).toBe("m_user_2");
  });

  it("preserves the assistant text and both tool calls on replay", () => {
    const turn = buildStructuredPiTurn(v6Thread(), MODEL, OPTIONS);
    const assistants = turn.history.filter((m) => m.role === "assistant");
    const content = assistants.flatMap(
      (m) => m.content as Array<{ type: string; text?: string; name?: string }>,
    );

    expect(content.find((c) => c.type === "text")?.text).toBe("Let me look that up.");
    expect(
      content
        .filter((c) => c.type === "toolCall")
        .map((c) => c.name)
        .sort(),
    ).toEqual(["invoke_operation", "search_operations"]);
    expect(turn.toolCallCount).toBe(2);
    expect(turn.toolResultCount).toBe(2);

    // Reasoning is deliberately NOT projected: Appstrate never persists the
    // signature that would make a thinking block replayable, so replaying its
    // text would re-bill private reasoning as public prose every later turn.
    expect(content.some((c) => c.text?.includes("wants to connect Gmail"))).toBe(false);
  });

  it("carries both tool results with their call ids and redacts the persisted connect link", () => {
    const results = toolResults(buildStructuredPiTurn(v6Thread(), MODEL, OPTIONS).history);

    expect(results.map((r) => r.toolCallId).sort()).toEqual(["call_dynamic_1", "call_static_1"]);
    expect(results.every((r) => r.isError === false)).toBe(true);

    // The connect_url persisted in the static tool's output is redacted on
    // replay — the model never re-sees a link it should not paste.
    const staticResult = results.find((r) => r.toolCallId === "call_static_1")!;
    const block = staticResult.content[0] as { type: "text"; text: string };
    const parsed = JSON.parse(block.text) as { ok: boolean; connect_url: string };
    expect(parsed.connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(parsed.ok).toBe(true);
  });

  it("projects an orphaned tool call without a synthesized result", () => {
    // A turn that died mid-call persists the part in a non-terminal state. Pi's
    // own request transform synthesizes the missing result, so the projection
    // must emit the call alone rather than inventing one.
    const thread = v6Thread();
    const assistant = thread[1]!;
    assistant.parts = [
      { type: "text", text: "working" },
      {
        type: "tool-search_operations",
        toolCallId: "call_orphan",
        state: "input-available",
        input: { query: "gmail" },
      } as never,
    ];
    const turn = buildStructuredPiTurn(thread, MODEL, OPTIONS);
    expect(turn.toolCallCount).toBe(1);
    expect(turn.toolResultCount).toBe(0);
    expect(toolResults(turn.history)).toEqual([]);
  });
});
