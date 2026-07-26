// SPDX-License-Identifier: Apache-2.0

/**
 * Turn-control primitives for the Pi subscription chat engine: what ends a turn,
 * and what the user is told about it.
 *
 * Two guards live here, both deliberately pure/injectable so they are unit
 * testable without a live model or a container:
 *
 *  1. **Deadline vs explicit stop.** The engine folds a user stop and its
 *     wall-clock ceiling into a single `AbortController`. Tagging the deadline
 *     with {@link ChatTurnDeadlineError} is what lets the finish path tell them
 *     apart — a user stop is a normal ending (the user already knows), a
 *     deadline is a truncation the user must be told about, in a REAL text part
 *     (`text-start`/`text-delta`/`text-end`). An `error` chunk would not do:
 *     error chunks are transient and never become persisted message parts,
 *     which is exactly how a 10-minute turn once ended as an empty message.
 *
 *  2. **Step cap ("early-stopping generate").** `CHAT_MAX_STEPS` used to be
 *     reported by this engine and never enforced. {@link createStepCapController}
 *     enforces it the way the ai-sdk engine does (`prepareAiSdkChatStep`): stop
 *     the tool loop at `CHAT_TOOL_STEP_BUDGET`, then issue exactly ONE more
 *     model call WITHOUT tools carrying `CHAT_FINAL_STEP_SYSTEM_PROMPT`, so the
 *     user gets a synthesis of the work already done instead of a truncated
 *     tool call.
 */

import type { UIMessageChunk } from "ai";
import {
  CHAT_FINAL_STEP_SYSTEM_PROMPT,
  CHAT_TOOL_STEP_BUDGET,
  type ChatTurnFinishReason,
} from "@appstrate/core/chat-turn-metadata";

/**
 * Abort reason marking the engine's wall-clock ceiling (as opposed to the user
 * pressing stop). Carries a structural brand as well as the class identity so
 * the check survives a duplicated module instance.
 */
export class ChatTurnDeadlineError extends Error {
  readonly chatTurnDeadline = true;

  constructor(deadlineMs: number) {
    super(`chat turn deadline (${deadlineMs} ms)`);
    this.name = "ChatTurnDeadlineError";
  }
}

/** Whether an abort reason is the turn deadline (and not an explicit stop). */
export function isChatTurnDeadline(reason: unknown): boolean {
  if (reason instanceof ChatTurnDeadlineError) return true;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { chatTurnDeadline?: unknown }).chatTurnDeadline === true
  );
}

/**
 * Decide how a turn closes: the finish reason to publish, and whether the
 * deadline notice must be written.
 *
 * A genuine engine failure wins over the deadline — an errored turn ALWAYS
 * surfaces its error (the engine's standing invariant), and claiming "time
 * limit" would hide the real cause.
 */
export function resolveTurnClosure(input: {
  aborted: boolean;
  abortReason: unknown;
  finishReason: ChatTurnFinishReason;
}): { finishReason: ChatTurnFinishReason; deadlineReached: boolean } {
  const deadlineReached =
    input.aborted && isChatTurnDeadline(input.abortReason) && input.finishReason !== "error";
  return {
    finishReason: deadlineReached ? "deadline" : input.finishReason,
    deadlineReached,
  };
}

/**
 * User-facing notice for a turn cut by the deadline (French — this product's UI
 * language). Says what happened, that launched runs survive the turn, and how
 * to pick their results back up.
 */
export function turnDeadlineNoticeText(deadlineMs: number): string {
  const minutes = Math.max(1, Math.round(deadlineMs / 60_000));
  return (
    `⏱️ Ce tour a atteint sa limite de temps (${minutes} minutes) et a été interrompu ici.\n\n` +
    `Les runs déjà lancés ne sont pas annulés : ils continuent de s'exécuter en arrière-plan. ` +
    `Envoyez-moi un message pour que je récupère leurs résultats et reprenne le travail où il s'est arrêté.`
  );
}

/**
 * A standalone text part written directly into the UI message stream. Unlike an
 * `error` chunk this becomes a persisted message part, so a reloaded
 * conversation still shows it.
 */
export function turnNoticeChunks(id: string, text: string): UIMessageChunk[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

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
  prompt(message: string): Promise<void>;
  agent: {
    afterToolCall?: (
      context: unknown,
      signal?: AbortSignal,
    ) => Promise<AfterToolCallOverride | undefined>;
  };
}

/** Structural view of the Pi session the engine drives (see `engine.ts`). */
export interface PiChatSession extends PiChatToolLoopSession {
  subscribe(cb: (event: unknown) => void): void;
  abort?(): Promise<void>;
}

export interface StepCapController {
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
  /** Prompt of the closing call. Defaults to the shared final-step directive. */
  finalStepPrompt?: string;
}): StepCapController {
  const budget = options.budget ?? CHAT_TOOL_STEP_BUDGET;
  const finalStepPrompt = options.finalStepPrompt ?? CHAT_FINAL_STEP_SYSTEM_PROMPT;
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
      await session.prompt(finalStepPrompt);
    },
  };
}
