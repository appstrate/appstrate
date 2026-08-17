// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { loadPiCodingAgentSdk, type Api } from "@appstrate/runner-pi";
import {
  buildStructuredPiTurn,
  reconstructPiSession,
  type PiHistoryModel,
} from "../src/pi-chat/structured-session.ts";

const MODEL: PiHistoryModel = {
  api: "openai-completions" as Api,
  provider: "openai",
  model: "preset_phase2",
};

const toolThread: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Trouve un agent" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "Je dois chercher dans le catalogue." },
      { type: "text", text: "Je lance une recherche." },
      { type: "step-start" },
      {
        type: "dynamic-tool",
        toolName: "search_operations",
        toolCallId: "call_search",
        state: "output-available",
        input: { query: "agents" },
        output: { agents: [{ id: "agent_1", name: "Analyste" }] },
      } as never,
      { type: "step-start" },
      { type: "text", text: "L’agent Analyste est disponible." },
    ],
  },
  {
    id: "a2",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "invoke_operation",
        toolCallId: "call_error",
        state: "output-error",
        input: { operationId: "missing" },
        errorText: "operation not found",
      } as never,
    ],
  },
  {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "Rappelle-moi le résultat et l’erreur." }],
  },
];

describe("structured Pi session reconstruction", () => {
  it("preserves roles, reasoning, tool calls, results, errors and prompt order", () => {
    const turn = buildStructuredPiTurn(toolThread, MODEL);
    expect(turn.prompt).toBe("Rappelle-moi le résultat et l’erreur.");
    expect(turn.branchHeadId).toBe("u2");
    expect(turn.sourceMessageCount).toBe(3);
    expect(turn.toolCallCount).toBe(2);
    expect(turn.toolResultCount).toBe(2);
    expect(turn.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "assistant",
      "assistant",
      "toolResult",
    ]);

    const calls = turn.history
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "toolCall");
    expect(calls.map((call) => call.id)).toEqual(["call_search", "call_error"]);

    const results = turn.history.filter((message) => message.role === "toolResult");
    expect(results[0]).toMatchObject({
      toolCallId: "call_search",
      toolName: "search_operations",
      isError: false,
    });
    expect(results[1]).toMatchObject({
      toolCallId: "call_error",
      toolName: "invoke_operation",
      isError: true,
    });
  });

  it("reconstructs identical context after a simulated server restart without a Pi file", async () => {
    const { SessionManager } = await loadPiCodingAgentSdk();
    const turn = buildStructuredPiTurn(toolThread, MODEL);
    const beforeRestart = reconstructPiSession(SessionManager, turn.history);
    const afterRestart = reconstructPiSession(SessionManager, turn.history);

    expect(beforeRestart.getSessionFile()).toBeUndefined();
    expect(afterRestart.getSessionFile()).toBeUndefined();
    expect(afterRestart.buildSessionContext().messages).toEqual(
      beforeRestart.buildSessionContext().messages,
    );
  });

  it("rebuilds only the selected sibling branch", () => {
    const common: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "Point commun" }] },
      { id: "a0", role: "assistant", parts: [{ type: "text", text: "Tronc commun" }] },
    ];
    const branchA: UIMessage[] = [
      ...common,
      { id: "uA", role: "user", parts: [{ type: "text", text: "branche-alpha" }] },
      { id: "aA", role: "assistant", parts: [{ type: "text", text: "secret-alpha" }] },
      { id: "uA2", role: "user", parts: [{ type: "text", text: "Continue A" }] },
    ];
    const branchB: UIMessage[] = [
      ...common,
      { id: "uB", role: "user", parts: [{ type: "text", text: "branche-beta" }] },
      { id: "aB", role: "assistant", parts: [{ type: "text", text: "secret-beta" }] },
      { id: "uB2", role: "user", parts: [{ type: "text", text: "Continue B" }] },
    ];

    const projectedA = JSON.stringify(buildStructuredPiTurn(branchA, MODEL));
    const projectedB = JSON.stringify(buildStructuredPiTurn(branchB, MODEL));
    expect(projectedA).toContain("secret-alpha");
    expect(projectedA).not.toContain("secret-beta");
    expect(projectedB).toContain("secret-beta");
    expect(projectedB).not.toContain("secret-alpha");
  });

  it("does not replay a stopped, unanswered user request into the next turn", () => {
    const stoppedThread: UIMessage[] = [
      { id: "u-stop", role: "user", parts: [{ type: "text", text: "Écris 5000 mots" }] },
      {
        id: "a-stop",
        role: "assistant",
        parts: [{ type: "step-start" }],
        metadata: {
          appstrate: {
            turn: {
              engine: "pi",
              finishReason: "stop",
              stepCount: 0,
              maxSteps: 16,
              maxStepsReached: false,
            },
          },
        },
      } as UIMessage,
      { id: "u-next", role: "user", parts: [{ type: "text", text: "Nouvelle demande" }] },
    ];

    const turn = buildStructuredPiTurn(stoppedThread, MODEL);
    expect(turn.prompt).toBe("Nouvelle demande");
    expect(JSON.stringify(turn.history)).not.toContain("Écris 5000 mots");
    expect(turn.sourceMessageCount).toBe(2);
  });

  it("reprojects history for the currently selected model instead of caching an old version", () => {
    const first = buildStructuredPiTurn(toolThread, MODEL);
    const changed = buildStructuredPiTurn(toolThread, {
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-current",
    });
    const firstAssistant = first.history.find((message) => message.role === "assistant");
    const changedAssistant = changed.history.find((message) => message.role === "assistant");
    expect(firstAssistant).toMatchObject({ model: "preset_phase2", provider: "openai" });
    expect(changedAssistant).toMatchObject({
      model: "claude-sonnet-current",
      provider: "anthropic",
    });
  });

  it("rejects a projection that does not end at the active user branch head", () => {
    expect(() => buildStructuredPiTurn(toolThread.slice(0, -1), MODEL)).toThrow(
      "must end with a user message",
    );
  });
});
