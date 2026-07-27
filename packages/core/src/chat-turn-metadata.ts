// SPDX-License-Identifier: Apache-2.0

export type ChatTurnEngine = "ai-sdk" | "subscription";
/**
 * `deadline` is Appstrate's own reason (no provider emits it): the turn was cut
 * by the engine's wall-clock ceiling. It exists so a timed-out turn stops being
 * disguised as the provider reason of its last completed step (typically
 * `tool-calls`), which made a silent truncation indistinguishable from a normal
 * tool step.
 */
export type ChatTurnFinishReason =
  "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "deadline" | "unknown";

export const CHAT_MAX_STEPS = 16;
export const CHAT_TOOL_STEP_BUDGET = CHAT_MAX_STEPS - 1;
export const CHAT_FINAL_STEP_SYSTEM_PROMPT =
  "You are on the final step budget for this turn. Do not call tools. Give the user a concise final answer from the evidence already gathered, explicitly mark any remaining checks as untested, and ask them to continue if more tool work is needed.";

/**
 * Wall-clock ceiling for ONE chat turn — the TIME budget, as `CHAT_MAX_STEPS`
 * is the step budget. Shared by both engines so a child call can never be
 * granted more time than the turn hosting it (the Pi engine used to own this
 * constant privately while `RUN_AND_WAIT_MAX_MS` let a run wait 3× longer than
 * the whole turn).
 */
export const CHAT_TURN_DEADLINE_MS = 10 * 60_000;

/**
 * Reserve subtracted from the turn's remaining time before handing a budget to
 * a child call, so the tool-less closing step (`CHAT_FINAL_STEP_SYSTEM_PROMPT`)
 * still has room to run and the user gets an answer instead of a truncation.
 */
export const CHAT_TURN_SAFETY_MARGIN_MS = 45_000;

/**
 * Launch floor for a run started from a chat turn. Measured: cold start is
 * ~800 ms under docker, but the fastest run that actually COMPLETED in the
 * audited session took 43 s. Below this, launching means paying for a run whose
 * result is thrown away when the turn ends — refuse instead.
 */
export const CHAT_MIN_RUN_BUDGET_MS = 90_000;

/**
 * Remaining turn time a launch actually requires — THE number every
 * model-facing message must quote.
 *
 * {@link computeTurnRunBudget} spends {@link CHAT_TURN_SAFETY_MARGIN_MS} before
 * comparing against {@link CHAT_MIN_RUN_BUDGET_MS}, so the bare floor is not the
 * gate: a message quoting it tells a model with 1m50s left that it may launch,
 * and the gate then refuses it. Derived once here because the same wrong number
 * has already been written twice independently (the budget note and the refusal
 * payload) — two texts restating the arithmetic drift, one constant cannot.
 */
export const CHAT_LAUNCH_THRESHOLD_MS = CHAT_MIN_RUN_BUDGET_MS + CHAT_TURN_SAFETY_MARGIN_MS;

/** Time budget a chat turn can still hand to a child call. */
export interface TurnRunBudget {
  /** Milliseconds left before the turn's own ceiling (never negative). */
  remainingMs: number;
  /** Milliseconds a child call may consume: `remainingMs` minus the reserve. */
  maxMs: number;
  /** Whether a run may be launched at all (`maxMs >= CHAT_MIN_RUN_BUDGET_MS`). */
  launchable: boolean;
}

/**
 * THE budget arithmetic — the single place the deadline is turned into a child
 * budget, used by both chat engines (deadline propagation: an absolute
 * timestamp descends, every caller derives its own remaining slice from it, and
 * the whole subtree dies at the same instant).
 */
export function computeTurnRunBudget(turnDeadlineAt: number, now: number): TurnRunBudget {
  const remainingMs = Math.max(0, turnDeadlineAt - now);
  const maxMs = Math.max(0, remainingMs - CHAT_TURN_SAFETY_MARGIN_MS);
  const launchable = maxMs >= CHAT_MIN_RUN_BUDGET_MS;
  return { remainingMs, maxMs, launchable };
}

/** Compact human duration for model-facing budget text ("4m12s", "45s"). */
export function formatBudgetDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * The budget line shown to the MODEL on every step (A5). A model that cannot
 * see its budget cannot manage it — the audited turn launched a ~2-minute
 * compilation with 22 seconds left on the clock.
 *
 * Deliberately one short, stable line: both engines place it where it cannot
 * invalidate a prompt-cache prefix (ai-sdk: a second system block AFTER the
 * cache breakpoint; Pi: appended to a tool result, i.e. frozen into the
 * transcript once written).
 *
 * The launch threshold it quotes is derived from {@link computeTurnRunBudget},
 * NOT restated: the gate spends `CHAT_TURN_SAFETY_MARGIN_MS` of the remaining
 * time before comparing against `CHAT_MIN_RUN_BUDGET_MS`, so a note advertising
 * the bare minimum would tell a model with 1m50s left that it may launch and
 * then refuse it. A model arbitrating on the wrong number is worse than one
 * shown no number at all — that is the whole point of A5.
 */
export function formatTurnBudgetNote(input: { remainingMs: number; stepsUsed: number }): string {
  const launchThreshold = formatBudgetDuration(CHAT_LAUNCH_THRESHOLD_MS);
  return (
    `[turn budget] ${formatBudgetDuration(input.remainingMs)} left in this turn, ` +
    `step ${input.stepsUsed}/${CHAT_MAX_STEPS}. ` +
    `A run_and_wait launch needs at least ${launchThreshold} left or it is refused; ` +
    `anything not written into your reply before the turn ends is lost.`
  );
}

export interface AppstrateTurnMetadata {
  engine: ChatTurnEngine;
  finishReason?: ChatTurnFinishReason;
  /**
   * Client-safe failure message when `finishReason` is "error". Persisted with
   * the turn (unlike the transient UI-stream `error` chunk) so a reloaded
   * conversation can still show why the turn failed.
   */
  errorText?: string;
  stepCount: number;
  maxSteps: number;
  toolStepBudget?: number;
  toolStepBudgetReached?: boolean;
  maxStepsReached: boolean;
  lastToolName?: string;
}

export interface ChatMessageMetadata {
  appstrate?: {
    turn?: AppstrateTurnMetadata;
  };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeTurnMetadata(
  existing: unknown,
  turn: AppstrateTurnMetadata,
): ChatMessageMetadata {
  const root = isRecord(existing) ? existing : {};
  const appstrate = isRecord(root.appstrate) ? root.appstrate : {};
  return {
    ...root,
    appstrate: {
      ...appstrate,
      turn,
    },
  };
}

export function isFinalChatStep(stepNumber: number, maxSteps = CHAT_MAX_STEPS): boolean {
  return stepNumber >= maxSteps - 1;
}

export function turnMetadataFromMessage(message: unknown): AppstrateTurnMetadata | null {
  if (!isRecord(message)) return null;
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const appstrate = metadata && isRecord(metadata.appstrate) ? metadata.appstrate : null;
  const turn = appstrate && isRecord(appstrate.turn) ? appstrate.turn : null;
  if (!turn) return null;
  if (turn.engine !== "ai-sdk" && turn.engine !== "subscription") return null;
  if (typeof turn.stepCount !== "number") return null;
  if (typeof turn.maxSteps !== "number") return null;
  if (typeof turn.maxStepsReached !== "boolean") return null;
  return turn as unknown as AppstrateTurnMetadata;
}

export function turnLimitReached(message: unknown): boolean {
  const turn = turnMetadataFromMessage(message);
  return Boolean(turn?.maxStepsReached || turn?.toolStepBudgetReached);
}
