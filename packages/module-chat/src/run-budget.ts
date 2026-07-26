// SPDX-License-Identifier: Apache-2.0

/**
 * Turn-budget propagation for `run_and_wait` — ONE implementation shared by both
 * chat engines (`pi-chat/mcp-tools.ts` and `platform-mcp.ts`).
 *
 * The defect this closes: `RUN_AND_WAIT_MAX_MS` is 30 minutes and neither engine
 * ever passed `maxMs`, so a tool call was allowed to wait THREE TIMES longer
 * than the 10-minute turn hosting it. Measured consequence: a run launched at
 * T+9:38 of a 10-minute turn, the turn died 22 s later, the run succeeded 2
 * minutes after that and its output was orphaned — 4.68 USD for nothing.
 *
 * The fix is canonical deadline propagation: an ABSOLUTE deadline timestamp
 * descends into the call, each callee derives its own remaining slice
 * ({@link computeTurnRunBudget}), the whole subtree dies at the same instant,
 * and a call whose remaining budget is obviously insufficient is REFUSED rather
 * than launched to be thrown away.
 *
 * A refusal is NOT a failure: no run row is created, nothing is billed, and the
 * result the model reads is a plain (non-error) payload saying so explicitly.
 */

import {
  CHAT_MIN_RUN_BUDGET_MS,
  CHAT_TURN_SAFETY_MARGIN_MS,
  computeTurnRunBudget,
  formatBudgetDuration,
  type ChatTurnEngine,
} from "@appstrate/core/chat-turn-metadata";
import {
  runAndWaitStepsWithDocuments,
  type RunAndWaitClientOptions,
  type RunAndWaitStep,
} from "@appstrate/core/run-and-wait-client";
import { logger } from "./logger.ts";

/** The turn's time budget, as seen by a tool call inside it. */
export interface TurnBudgetContext {
  /** Absolute wall-clock instant the turn ends (`turnStart + CHAT_TURN_DEADLINE_MS`). */
  turnDeadlineAt: number;
  /** Which engine hosts the turn — trace attribution only. */
  engine: ChatTurnEngine;
  /** Chat session the turn belongs to — trace attribution only. */
  chatSessionId?: string | null;
  /** Clock seam (tests inject a fixed now). */
  now?: () => number;
}

/** Minimal logger seam so the decision stays testable without `mock.module()`. */
export interface BudgetLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type RunBudgetDecision =
  { launch: true; maxMs: number } | { launch: false; payload: Record<string, unknown> };

/**
 * Decide whether a run may be launched inside the remaining turn budget, and
 * with how much time. The refusal payload is deliberately shaped so the model
 * cannot confuse it with a run failure: `launched:false` + a stable `reason`,
 * no `error`/`status` field, and the step is never flagged `isError`.
 */
export function decideRunAndWaitBudget(
  ctx: TurnBudgetContext,
  log: BudgetLogger = logger,
): RunBudgetDecision {
  const now = (ctx.now ?? Date.now)();
  const budget = computeTurnRunBudget(ctx.turnDeadlineAt, now);

  if (!budget.launchable) {
    log.warn("chat run_and_wait refused — insufficient turn budget", {
      engine: ctx.engine,
      chatSessionId: ctx.chatSessionId ?? null,
      remainingMs: budget.remainingMs,
      runBudgetMs: budget.maxMs,
      minRunBudgetMs: CHAT_MIN_RUN_BUDGET_MS,
    });
    return {
      launch: false,
      payload: {
        launched: false,
        reason: "insufficient_turn_budget",
        remaining_ms: budget.remainingMs,
        run_budget_ms: budget.maxMs,
        min_run_budget_ms: CHAT_MIN_RUN_BUDGET_MS,
        message:
          `No run was launched: only ${formatBudgetDuration(budget.maxMs)} of this turn's ` +
          `time budget remain, below the ${formatBudgetDuration(CHAT_MIN_RUN_BUDGET_MS)} ` +
          `minimum a run needs. Nothing was created and nothing was spent — this is not a ` +
          `failure. Summarise the work already done in your reply now, and tell the user to ` +
          `send a message so this run can be relaunched at the start of the next turn.`,
      },
    };
  }

  if (budget.thin) {
    // The low `deadline.remaining_ms` we want visible in traces: the run WILL
    // start, but it is racing the turn that hosts it.
    log.warn("chat run_and_wait launched on a thin turn budget", {
      engine: ctx.engine,
      chatSessionId: ctx.chatSessionId ?? null,
      remainingMs: budget.remainingMs,
      runBudgetMs: budget.maxMs,
      safetyMarginMs: CHAT_TURN_SAFETY_MARGIN_MS,
    });
  }

  return { launch: true, maxMs: budget.maxMs };
}

/**
 * {@link runAndWaitStepsWithDocuments}, bounded by the hosting turn's deadline.
 * Both engines call THIS — the gate and the `maxMs` derivation exist once.
 *
 * `steps` is injected (production default) so the budget can be asserted in a
 * unit test without stubbing modules.
 */
export async function* runAndWaitStepsWithinTurnBudget(
  rawArgs: unknown,
  opts: Omit<RunAndWaitClientOptions, "maxMs"> & { budget: TurnBudgetContext },
  steps: typeof runAndWaitStepsWithDocuments = runAndWaitStepsWithDocuments,
): AsyncGenerator<RunAndWaitStep> {
  const { budget, ...clientOpts } = opts;
  const decision = decideRunAndWaitBudget(budget);
  if (!decision.launch) {
    // Returned BEFORE any HTTP call — no `runs` row, no cost, no orphan.
    yield { payload: decision.payload };
    return;
  }
  yield* steps(rawArgs, { ...clientOpts, maxMs: decision.maxMs });
}
