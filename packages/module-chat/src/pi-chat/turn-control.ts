// SPDX-License-Identifier: Apache-2.0

/**
 * Step-cap control for the Pi subscription chat engine — the ONE guard that is
 * genuinely Pi-specific.
 *
 * **Step cap ("early-stopping generate").** `CHAT_MAX_STEPS` used to be reported
 * by this engine and never enforced. {@link createStepCapController} enforces it
 * the way the ai-sdk engine does (`prepareAiSdkChatStep`): stop the tool loop at
 * `CHAT_TOOL_STEP_BUDGET`, then issue exactly ONE more model call WITHOUT tools
 * carrying `CHAT_FINAL_STEP_SYSTEM_PROMPT`, so the user gets a synthesis of the
 * work already done instead of a truncated tool call. It is deliberately
 * pure/injectable so it is unit testable without a live model or a container.
 *
 * The other guard that used to live here — deadline vs explicit stop, and the
 * user-facing notice a deadline owes the user — is engine-neutral (both engines
 * enforce the same ceiling and close the turn the same way) and now lives in
 * `../turn-closure.ts`.
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

/**
 * Whether a finalized tool result carries a `connectOffer` — the typed payload
 * the chat's connect card renders its button from.
 *
 * It matters here because pi-agent-core rebuilds a tool result as exactly
 * `{content, details, terminate}` whenever `afterToolCall` returns a TRUTHY
 * override (`agent-loop.js:408-415`), dropping every other field. `details` is
 * redacted, so nothing falls back: terminating through this hook on a batch
 * carrying an offer would strip the connect URL and leave the user a dead end
 * at the exact moment the turn closes. `mcp-tools.ts` states that contract.
 *
 * `shouldStopAfterTurn` would stop the loop without rewriting any result, but
 * it is unreachable from an `AgentSession`: `Agent.createLoopConfig` forwards
 * `beforeToolCall`/`afterToolCall` only (`agent.js:288-289`), never that hook.
 * So the offer's batch is let through untouched and the cap fires on the next
 * one — at most one extra tool step, in a rare case.
 */
function carriesConnectOffer(context: unknown): boolean {
  const result = (context as { result?: unknown } | null | undefined)?.result;
  if (typeof result !== "object" || result === null) return false;
  return (result as { connectOffer?: unknown }).connectOffer != null;
}

/** Batch identity: every tool call finalized in one batch shares its assistant message. */
function batchKey(context: unknown): object | undefined {
  const message = (context as { assistantMessage?: unknown } | null | undefined)?.assistantMessage;
  return typeof message === "object" && message !== null ? message : undefined;
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
}): StepCapController {
  const budget = options.budget ?? CHAT_TOOL_STEP_BUDGET;
  let fired = false;
  // Batches spared because one of their results carries a connect offer. Keyed
  // by the shared assistant message so the whole batch is spared, not just the
  // one call — `terminate` is only honoured when EVERY result in the batch sets
  // it, so a split decision would leave `fired` true with the loop still running.
  const sparedBatches = new WeakSet<object>();

  return {
    attach(session) {
      // Wrap (never replace) the hook AgentSession installed: it forwards
      // `tool_result` to extensions, and dropping it would silence them.
      const inner = session.agent.afterToolCall;
      session.agent.afterToolCall = async (context, signal) => {
        const override = await inner?.(context, signal);
        if (options.modelCallCount() < budget) return override;
        // See `carriesConnectOffer`: terminating through this hook rebuilds the
        // result and silently drops the offer, leaving the user a connect card
        // with no URL. Spare the batch and cap on the next one.
        const batch = batchKey(context);
        if (carriesConnectOffer(context) && batch) sparedBatches.add(batch);
        if (batch && sparedBatches.has(batch)) return override;
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
