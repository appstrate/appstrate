// SPDX-License-Identifier: Apache-2.0

import type { ModelErrorCategory } from "./model-error.ts";

/**
 * The chat surface's name for {@link ModelErrorCategory} — an ALIAS, not a
 * second vocabulary. It stays because the values are persisted under this name
 * (`AppstrateTurnMetadata.errorCategory`, on immutable chat messages) and
 * because out-of-tree readers import it; the rules that produce them live in
 * `./model-error.ts`, shared with the run surface.
 */
export type ChatTurnErrorCategory = ModelErrorCategory;

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
 * is the step budget. The one ceiling every child budget derives from, so a
 * child call can never be
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
 * budget, used by the chat engine (deadline propagation: an absolute
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
 * Deliberately one short, stable line, placed where it cannot invalidate a
 * prompt-cache prefix (appended to a tool result, i.e. frozen into the
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
  finishReason?: ChatTurnFinishReason;
  /**
   * Stable, provider-neutral class for retry UI + telemetry.
   *
   * OPTIONAL because it is stamped only on a turn that actually carried an
   * error: `buildPiTurnMetadata` (`pi-chat/pi-turn-closure.ts`) derives it from
   * the classified `ClientTurnError`, and the ordinary turn — the one that
   * simply finished — has none. So a reader indexing a table by this field must
   * carry a default for the common case, not for a historical one; the client
   * degrades a category-less turn to `unknown` rather than rendering raw
   * upstream text.
   */
  errorCategory?: ChatTurnErrorCategory;
  /** Whether retrying later may succeed without changing the request. */
  errorRetryable?: boolean;
  /** Public platform request id when the upstream envelope exposed one. */
  requestId?: string;
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

export function turnMetadataFromMessage(message: unknown): AppstrateTurnMetadata | null {
  if (!isRecord(message)) return null;
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const appstrate = metadata && isRecord(metadata.appstrate) ? metadata.appstrate : null;
  const turn = appstrate && isRecord(appstrate.turn) ? appstrate.turn : null;
  if (!turn) return null;
  // The shape gate is the three step counters. It used to also require an
  // `engine` string, which was the only reader that field ever had — the check
  // existed because the field existed. Rows written before the chat unified on
  // one engine still carry it; an unread extra key decodes fine, so nothing had
  // to be rewritten or deleted when it went away.
  if (typeof turn.stepCount !== "number") return null;
  if (typeof turn.maxSteps !== "number") return null;
  if (typeof turn.maxStepsReached !== "boolean") return null;
  return turn as unknown as AppstrateTurnMetadata;
}

/**
 * Did this turn stop because it ran out of budget?
 *
 * One field answers it. `maxStepsReached` is what the single writer sets
 * (`pi-turn-closure.ts`, from `input.stepCapReached`) and it is the SHAPE GATE
 * above — every historical writer emitted it, which is why the gate can require
 * it.
 *
 * This used to read `maxStepsReached || toolStepBudgetReached`, for rows
 * written before the chat unified on one engine. The second arm reached less
 * than it appeared to: the gate already rejects a turn carrying
 * `toolStepBudgetReached` alone, so the only rows it could speak for were those
 * carrying both with `maxStepsReached: false`. Those were folded by
 * `scripts/migration/0006-chat-turn-step-cap-fold.sql`, and the read is one
 * form again (`docs/NO_TRANSITIONAL_CODE.md` §1).
 */
export function turnLimitReached(message: unknown): boolean {
  return Boolean(turnMetadataFromMessage(message)?.maxStepsReached);
}
