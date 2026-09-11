// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  CHAT_FINAL_STEP_SYSTEM_PROMPT,
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
} from "@appstrate/core/chat-turn-metadata";
import {
  createStepCapController,
  type AfterToolCallOverride,
  type PiChatToolLoopSession,
} from "../src/pi-chat/turn-control.ts";

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
