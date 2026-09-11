// SPDX-License-Identifier: Apache-2.0

/**
 * Step-cap control for the Pi chat engine — the ONE guard that is
 * genuinely Pi-specific.
 *
 * **Step cap ("early-stopping generate").** `CHAT_MAX_STEPS` used to be reported
 * by this engine and never enforced. {@link createStepCapController} enforces it:
 * stop the tool loop at
 * `CHAT_TOOL_STEP_BUDGET`, then issue exactly ONE more model call WITHOUT tools
 * carrying `CHAT_FINAL_STEP_SYSTEM_PROMPT`, so the user gets a synthesis of the
 * work already done instead of a truncated tool call. It is deliberately
 * pure/injectable so it is unit testable without a live model or a container.
 *
 * The other guard that used to live here — deadline vs explicit stop, and the
 * user-facing notice a deadline owes the user — lives next door in
 * `./pi-turn-closure.ts`, alongside the terminal metadata every Pi exit path
 * publishes.
 */

import {
  CHAT_FINAL_STEP_SYSTEM_PROMPT,
  CHAT_TOOL_STEP_BUDGET,
} from "@appstrate/core/chat-turn-metadata";

/** Partial override returned by pi-agent-core's `afterToolCall` hook. */
export interface AfterToolCallOverride {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
  /**
   * Early-termination hint. The agent loop stops after the current tool batch
   * only when EVERY finalized result in that batch sets it — which holds here
   * because the budget is evaluated per batch, not per call.
   */
  terminate?: boolean;
}

/** The slice of the Pi `AgentSession` the step cap drives. */
export interface PiChatToolLoopSession {
  /** Restrict the tools exposed on the NEXT run (`[]` = tool-less). */
  setActiveToolsByName(toolNames: string[]): void;
  prompt(message: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  agent: {
    afterToolCall?: (
      context: unknown,
      signal?: AbortSignal,
    ) => Promise<AfterToolCallOverride | undefined>;
  };
}

/** Structural view of the Pi session the engine drives (see `engine.ts`). */
export interface PiChatSession extends PiChatToolLoopSession {
  /**
   * Returns the DETACH handle. Declaring it `void` here (which it was) threw
   * the handle away at the type level, so the engine could not release the
   * subscription when the turn ended and a late Pi event still reached a
   * closed stream writer — a `TypeError: Invalid state` thrown from outside
   * any caller's try/catch.
   */
  subscribe(cb: (event: unknown) => void): () => void;
  abort?(): Promise<void>;
}

interface StepCapController {
  /** Wrap the session's `afterToolCall` hook so the tool loop stops at the budget. */
  attach(session: PiChatToolLoopSession): void;
  /** Whether the cap actually fired (never true by arithmetic alone). */
  fired(): boolean;
  /** The single tool-less closing model call. */
  runFinalStep(session: PiChatToolLoopSession): Promise<void>;
}

export function createStepCapController(options: {
  /** Model calls completed so far in this turn (`PiChatUiStreamMapper.stepCount`). */
  modelCallCount: () => number;
  /** Model calls allowed to use tools. Defaults to the shared chat budget. */
  budget?: number;
}): StepCapController {
  const budget = options.budget ?? CHAT_TOOL_STEP_BUDGET;
  let fired = false;

  return {
    attach(session) {
      // Wrap (never replace) the hook AgentSession installed: it forwards
      // `tool_result` to extensions, and dropping it would silence them.
      const inner = session.agent.afterToolCall;
      session.agent.afterToolCall = async (context, signal) => {
        const override = await inner?.(context, signal);
        if (options.modelCallCount() < budget) return override;
        fired = true;
        return { ...override, terminate: true };
      };
    },
    fired: () => fired,
    async runFinalStep(session) {
      // Tools are snapshotted per run by the agent loop, so they can only be
      // dropped between runs — which is precisely what this closing call is.
      session.setActiveToolsByName([]);
      await session.prompt(CHAT_FINAL_STEP_SYSTEM_PROMPT);
    },
  };
}
