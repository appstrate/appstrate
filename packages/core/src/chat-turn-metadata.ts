// SPDX-License-Identifier: Apache-2.0

/**
 * The engine a NEW turn is written with. There is exactly one, and this is not
 * a registry of engines that exist — it is the write side of a persisted field.
 *
 * Kept as a stamp even though nothing BRANCHES on it: chat messages are an
 * append-only store read for years, and this is the only record of what
 * produced a given row. It is what makes the ai-sdk → pi transition legible in
 * the data after the fact, and the field a future engine change would be
 * diagnosed with. Twelve bytes a turn.
 */
export type ChatTurnEngine = "pi";

/**
 * What the DECODER accepts off a stored row: the live engine, plus the two
 * markers written before the chat unified on one engine. Neither is an engine
 * that still exists; they are historical values that must keep decoding, or the
 * error state and the turn-limit notice stop rendering on old threads
 * ({@link turnMetadataFromMessage} rejects a row whose `engine` it does not
 * recognise).
 *
 * The split is the point: {@link mergeTurnMetadata} takes the narrow type, so
 * a legacy value cannot be written by accident, while reads stay permissive.
 */
export type PersistedChatTurnEngine = ChatTurnEngine | "ai-sdk" | "subscription";
export type ChatTurnErrorCategory =
  | "credential_unavailable"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_request"
  | "unknown";

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
  /** Wide on purpose — this interface is what a DECODED row looks like. */
  engine: PersistedChatTurnEngine;
  finishReason?: ChatTurnFinishReason;
  /**
   * Stable, provider-neutral class for retry UI + telemetry.
   *
   * Absent on a turn persisted before this field existed, when the failure copy
   * was the provider's own unclassified string (`errorText`, removed): such a
   * turn reads as `unknown` rather than rendering raw upstream text.
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

/** The values {@link turnMetadataFromMessage} will decode. */
const PERSISTED_CHAT_TURN_ENGINES: ReadonlySet<PersistedChatTurnEngine> = new Set([
  "pi",
  "ai-sdk",
  "subscription",
]);

/**
 * What a caller may WRITE: {@link AppstrateTurnMetadata} narrowed to the live
 * engine. Forging a legacy row (a test rehearsing the back-compat path) builds
 * the stored shape directly instead — going through today's writer to produce
 * yesterday's bytes is exactly what stops catching drift.
 */
export type ChatTurnMetadataInput = Omit<AppstrateTurnMetadata, "engine"> & {
  engine: ChatTurnEngine;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeTurnMetadata(
  existing: unknown,
  turn: ChatTurnMetadataInput,
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

export function isFinalChatStep(stepNumber: number): boolean {
  return stepNumber >= CHAT_MAX_STEPS - 1;
}

export function turnMetadataFromMessage(message: unknown): AppstrateTurnMetadata | null {
  if (!isRecord(message)) return null;
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const appstrate = metadata && isRecord(metadata.appstrate) ? metadata.appstrate : null;
  const turn = appstrate && isRecord(appstrate.turn) ? appstrate.turn : null;
  if (!turn) return null;
  if (!PERSISTED_CHAT_TURN_ENGINES.has(turn.engine as PersistedChatTurnEngine)) return null;
  if (typeof turn.stepCount !== "number") return null;
  if (typeof turn.maxSteps !== "number") return null;
  if (typeof turn.maxStepsReached !== "boolean") return null;
  return turn as unknown as AppstrateTurnMetadata;
}

export function turnLimitReached(message: unknown): boolean {
  const turn = turnMetadataFromMessage(message);
  return Boolean(turn?.maxStepsReached || turn?.toolStepBudgetReached);
}
