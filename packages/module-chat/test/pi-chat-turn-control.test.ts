// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  CHAT_FINAL_STEP_SYSTEM_PROMPT,
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
} from "@appstrate/core/chat-turn-metadata";
import {
  ChatTurnDeadlineError,
  createStepCapController,
  isChatTurnDeadline,
  resolveTurnClosure,
  turnDeadlineNoticeText,
  turnNoticeChunks,
  type AfterToolCallOverride,
  type PiChatToolLoopSession,
} from "../src/pi-chat/turn-control.ts";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";

const TEN_MINUTES = 10 * 60_000;

describe("turn abort causes", () => {
  it("recognises the deadline reason", () => {
    expect(isChatTurnDeadline(new ChatTurnDeadlineError(TEN_MINUTES))).toBe(true);
  });

  it("does not mistake an explicit stop for a deadline", () => {
    expect(isChatTurnDeadline(new Error("stopped by user"))).toBe(false);
    expect(isChatTurnDeadline("AbortError")).toBe(false);
    expect(isChatTurnDeadline(undefined)).toBe(false);
  });
});

describe("resolveTurnClosure", () => {
  it("reports a deadline-killed turn as finishReason:'deadline'", () => {
    const closure = resolveTurnClosure({
      aborted: true,
      abortReason: new ChatTurnDeadlineError(TEN_MINUTES),
      // What the incident produced: the last completed step was a tool call.
      finishReason: "tool-calls",
    });
    expect(closure).toEqual({ finishReason: "deadline", deadlineReached: true });
  });

  it("leaves an explicit stop untouched (distinct path)", () => {
    const closure = resolveTurnClosure({
      aborted: true,
      abortReason: new Error("stopped by user"),
      finishReason: "tool-calls",
    });
    expect(closure).toEqual({ finishReason: "tool-calls", deadlineReached: false });
  });

  it("leaves a turn that ended on its own untouched", () => {
    const closure = resolveTurnClosure({
      aborted: false,
      abortReason: undefined,
      finishReason: "stop",
    });
    expect(closure).toEqual({ finishReason: "stop", deadlineReached: false });
  });

  it("keeps a genuine engine error visible instead of claiming a deadline", () => {
    const closure = resolveTurnClosure({
      aborted: true,
      abortReason: new ChatTurnDeadlineError(TEN_MINUTES),
      finishReason: "error",
    });
    expect(closure).toEqual({ finishReason: "error", deadlineReached: false });
  });
});

describe("deadline notice", () => {
  it("writes a real, non-empty text part (not an error chunk)", () => {
    const chunks = turnNoticeChunks("notice-1", turnDeadlineNoticeText(TEN_MINUTES));
    expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const delta = chunks.find((c) => c.type === "text-delta") as { delta: string };
    expect(delta.delta.length).toBeGreaterThan(0);
  });

  it("states the time limit, the surviving runs, and how to resume", () => {
    const text = turnDeadlineNoticeText(TEN_MINUTES);
    expect(text).toContain("10 minutes");
    expect(text).toContain("arrière-plan");
    expect(text).toContain("message");
  });
});

/** Minimal stand-in for the Pi `AgentSession` slice the step cap drives. */
function fakeSession(inner?: PiChatToolLoopSession["agent"]["afterToolCall"]) {
  const calls = { activeTools: null as string[] | null, prompts: [] as string[] };
  const session: PiChatToolLoopSession = {
    setActiveToolsByName: (toolNames) => {
      calls.activeTools = toolNames;
    },
    prompt: async (message) => {
      calls.prompts.push(message);
    },
    agent: { afterToolCall: inner },
  };
  return { session, calls };
}

/**
 * Drive a synthetic tool loop: each iteration is one model call followed by one
 * tool batch, and the loop stops when the batch is flagged `terminate` — the
 * same contract pi-agent-core's `runLoop` applies.
 */
async function runToolLoop(session: PiChatToolLoopSession, onModelCall: () => void, max: number) {
  let batches = 0;
  for (let i = 0; i < max; i++) {
    onModelCall();
    batches += 1;
    const override = await session.agent.afterToolCall?.({}, undefined);
    if (override?.terminate === true) break;
  }
  return batches;
}

describe("createStepCapController", () => {
  it("stops the tool loop at the budget and closes with one tool-less call", async () => {
    let modelCalls = 0;
    const { session, calls } = fakeSession();
    const cap = createStepCapController({ modelCallCount: () => modelCalls });
    cap.attach(session);

    // Left alone the loop would run far past the cap (the audited incident).
    const batches = await runToolLoop(session, () => (modelCalls += 1), 40);

    expect(batches).toBe(CHAT_TOOL_STEP_BUDGET);
    expect(cap.fired()).toBe(true);

    await cap.runFinalStep(session);
    modelCalls += 1; // the closing model call

    expect(calls.activeTools).toEqual([]);
    expect(calls.prompts).toEqual([CHAT_FINAL_STEP_SYSTEM_PROMPT]);
    expect(modelCalls).toBe(CHAT_MAX_STEPS);
  });

  it("stays inert on a turn that ends before the budget", async () => {
    let modelCalls = 0;
    const { session, calls } = fakeSession();
    const cap = createStepCapController({ modelCallCount: () => modelCalls });
    cap.attach(session);

    await runToolLoop(session, () => (modelCalls += 1), 3);

    expect(cap.fired()).toBe(false);
    expect(calls.activeTools).toBeNull();
    expect(calls.prompts).toEqual([]);
  });

  it("preserves the hook it wraps (extension tool_result overrides)", async () => {
    let modelCalls = 0;
    const seen: unknown[] = [];
    const inner = async (context: unknown): Promise<AfterToolCallOverride> => {
      seen.push(context);
      return { isError: true, details: "from extension" };
    };
    const { session } = fakeSession(inner);
    const cap = createStepCapController({ modelCallCount: () => modelCalls, budget: 2 });
    cap.attach(session);

    modelCalls = 1;
    expect(await session.agent.afterToolCall?.({ n: 1 }, undefined)).toEqual({
      isError: true,
      details: "from extension",
    });

    modelCalls = 2;
    expect(await session.agent.afterToolCall?.({ n: 2 }, undefined)).toEqual({
      isError: true,
      details: "from extension",
      terminate: true,
    });
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe("PiChatUiStreamMapper.stepCount", () => {
  it("counts model calls only — not the user echo, not tool results", () => {
    const mapper = new PiChatUiStreamMapper();
    // Pi emits message_start/message_end for the prompt and for every tool
    // result too; counting those made `stepCount` several times the real
    // number of model calls.
    mapper.map({ type: "message_start", message: { role: "user" } });
    mapper.map({ type: "message_end", message: { role: "user" } });
    mapper.map({ type: "message_start", message: { role: "assistant" } });
    mapper.map({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
    mapper.map({ type: "message_start", message: { role: "toolResult" } });
    mapper.map({ type: "message_end", message: { role: "toolResult" } });
    mapper.map({ type: "message_start", message: { role: "assistant" } });
    mapper.map({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });

    expect(mapper.stepCount()).toBe(2);
  });

  it("keeps content-block ids unique across interleaved messages", () => {
    const mapper = new PiChatUiStreamMapper();
    const ids: string[] = [];
    for (const role of ["assistant", "toolResult", "assistant"]) {
      mapper.map({ type: "message_start", message: { role } });
      const chunks = mapper.map({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
      });
      for (const c of chunks) if (c.type === "text-start") ids.push(c.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
