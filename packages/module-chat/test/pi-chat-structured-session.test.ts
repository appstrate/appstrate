// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { loadPiCodingAgentSdk, type Api } from "@appstrate/runner-pi";
import {
  buildStructuredPiTurn,
  reconstructPiSession,
  type BuildStructuredPiTurnOptions,
  type PiHistoryModel,
} from "../src/pi-chat/structured-session.ts";

const { estimateTokens } = await loadPiCodingAgentSdk();
const OPTIONS: BuildStructuredPiTurnOptions = { estimateTokens, baseTokens: 0 };

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
    const turn = buildStructuredPiTurn(toolThread, MODEL, OPTIONS);
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
    const turn = buildStructuredPiTurn(toolThread, MODEL, OPTIONS);
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

    const projectedA = JSON.stringify(buildStructuredPiTurn(branchA, MODEL, OPTIONS));
    const projectedB = JSON.stringify(buildStructuredPiTurn(branchB, MODEL, OPTIONS));
    expect(projectedA).toContain("secret-alpha");
    expect(projectedA).not.toContain("secret-beta");
    expect(projectedB).toContain("secret-beta");
    expect(projectedB).not.toContain("secret-alpha");
  });

  it("keeps a cancelled request in history so the retry still has a referent", () => {
    const stoppedThread: UIMessage[] = [
      { id: "u-stop", role: "user", parts: [{ type: "text", text: "Écris 5000 mots" }] },
      { id: "a-stop", role: "assistant", parts: [{ type: "step-start" }] },
      { id: "u-next", role: "user", parts: [{ type: "text", text: "Nouvelle demande" }] },
    ];

    const turn = buildStructuredPiTurn(stoppedThread, MODEL, OPTIONS);
    expect(turn.prompt).toBe("Nouvelle demande");
    expect(JSON.stringify(turn.history)).toContain("Écris 5000 mots");
    expect(turn.sourceMessageCount).toBe(2);
  });

  it("keeps the failed request so the model knows what it is being asked to retry", () => {
    // `subscriptionFailureChunks` persists a provider failure as an assistant
    // message carrying metadata and no parts at all. Deleting the question it
    // failed to answer would leave the next model an unanswerable "Réessaie".
    const failedThread: UIMessage[] = [
      { id: "u-fail", role: "user", parts: [{ type: "text", text: "Analyse ce dépôt" }] },
      {
        id: "a-fail",
        role: "assistant",
        parts: [],
        metadata: {
          appstrate: {
            turn: { engine: "subscription", finishReason: "error", stepCount: 0 },
          },
        },
      } as unknown as UIMessage,
      { id: "u-retry", role: "user", parts: [{ type: "text", text: "Réessaie" }] },
    ];

    const turn = buildStructuredPiTurn(failedThread, MODEL, OPTIONS);
    expect(turn.prompt).toBe("Réessaie");
    expect(turn.history).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Analyse ce dépôt" }],
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("does not project reasoning parts", () => {
    const thread: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Question" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "raisonnement-prive" },
          { type: "text", text: "Réponse publique" },
        ],
      } as UIMessage,
      { id: "u2", role: "user", parts: [{ type: "text", text: "Suite" }] },
    ];

    const projected = JSON.stringify(buildStructuredPiTurn(thread, MODEL, OPTIONS).history);
    expect(projected).toContain("Réponse publique");
    expect(projected).not.toContain("raisonnement-prive");
    expect(projected).not.toContain("thinking");
  });

  it("emits no result for a tool call the turn never completed", () => {
    // Pi's request transform synthesizes the missing result for an orphaned
    // tool call itself; duplicating that here would drift from the SDK.
    const thread: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Lance" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "search_operations",
            toolCallId: "call_cut",
            state: "input-available",
            input: { query: "x" },
          },
        ],
      } as unknown as UIMessage,
      { id: "u2", role: "user", parts: [{ type: "text", text: "Alors ?" }] },
    ];

    const turn = buildStructuredPiTurn(thread, MODEL, OPTIONS);
    expect(turn.toolCallCount).toBe(1);
    expect(turn.toolResultCount).toBe(0);
    expect(turn.history.some((message) => message.role === "toolResult")).toBe(false);
  });

  it("carries tool-result images through instead of inlining base64 as text", () => {
    const thread: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Capture" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "screenshot",
            toolCallId: "call_img",
            state: "output-available",
            input: {},
            output: { content: [{ type: "image", data: "AAAB", mimeType: "image/png" }] },
          },
        ],
      } as unknown as UIMessage,
      { id: "u2", role: "user", parts: [{ type: "text", text: "Et ?" }] },
    ];

    const result = buildStructuredPiTurn(thread, MODEL, OPTIONS).history.find(
      (message) => message.role === "toolResult",
    );
    expect(result?.content).toEqual([{ type: "image", data: "AAAB", mimeType: "image/png" }]);
  });

  it("reports a context estimate so a long history cannot look empty to compaction", () => {
    const turn = buildStructuredPiTurn(toolThread, MODEL, OPTIONS);
    const assistants = turn.history.filter((message) => message.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const assistant of assistants) {
      expect(assistant.usage.totalTokens).toBeGreaterThan(0);
      expect(assistant.usage.totalTokens).toBe(assistant.usage.input);
    }
    // Monotonic: each assistant sees the context accumulated up to itself.
    const totals = assistants.map((assistant) => assistant.usage.totalTokens);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
  });

  it("stamps projected messages with real, strictly increasing milliseconds", () => {
    const before = Date.now();
    const stamps = buildStructuredPiTurn(toolThread, MODEL, OPTIONS).history.map(
      (m) => m.timestamp,
    );
    expect(stamps.length).toBeGreaterThan(1);
    expect(stamps[0]).toBeGreaterThanOrEqual(before);
    expect(stamps.every((value, i) => i === 0 || value > stamps[i - 1]!)).toBe(true);
  });

  it("never attributes historical assistants to the model running this turn", () => {
    // Claiming the current model makes Pi's `isSameModel` pass for history it
    // did not produce, which suppresses cross-model tool-call id normalization
    // and the Responses pairing guard. `api`/`provider` stay truthful so the
    // Responses path lands on its `isDifferentModel` branch.
    const first = buildStructuredPiTurn(toolThread, MODEL, OPTIONS);
    const changed = buildStructuredPiTurn(
      toolThread,
      { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-current" },
      OPTIONS,
    );
    const firstAssistant = first.history.find((message) => message.role === "assistant");
    const changedAssistant = changed.history.find((message) => message.role === "assistant");

    expect(firstAssistant?.model).not.toBe(MODEL.model);
    expect(changedAssistant?.model).not.toBe("claude-sonnet-current");
    expect(firstAssistant?.model).toBe(changedAssistant?.model);
    expect(firstAssistant).toMatchObject({ provider: "openai", api: "openai-completions" });
    expect(changedAssistant).toMatchObject({ provider: "anthropic", api: "anthropic-messages" });
  });

  it("rejects a projection that does not end at the active user branch head", () => {
    expect(() => buildStructuredPiTurn(toolThread.slice(0, -1), MODEL, OPTIONS)).toThrow(
      "must end with a user message",
    );
  });
});
