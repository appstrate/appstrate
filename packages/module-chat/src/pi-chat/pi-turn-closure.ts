// SPDX-License-Identifier: Apache-2.0

/**
 * How a Pi chat turn CLOSES, and what the user is told about it.
 *
 * `runPiChat` folds a user stop and the turn's wall-clock ceiling
 * (`CHAT_TURN_DEADLINE_MS`) into a single `AbortController`. Tagging the
 * deadline with {@link ChatTurnDeadlineError} is what lets the finish path tell
 * them apart: a user stop is a normal ending (the user already knows), a
 * deadline is a truncation the user must be told about, in a REAL text part
 * (`text-start`/`text-delta`/`text-end`). An `error` chunk would not do — error
 * chunks are transient and never become persisted message parts, which is
 * exactly how a 10-minute turn once ended as an empty message.
 *
 * These primitives used to sit one directory up, in `src/turn-closure.ts`, so
 * the AI-SDK loop and the Pi engine could share ONE closure rule. #1173 deleted
 * the AI-SDK loop; every caller is now under `pi-chat/`, so the neutral home no
 * longer buys anything and the rule lives with the only engine that applies it.
 * The step-cap controller stays next door in `pi-chat/turn-control.ts`.
 */

import type { UIMessageChunk } from "ai";
import {
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
  CHAT_TURN_DEADLINE_MS,
  mergeTurnMetadata,
  type ChatMessageMetadata,
  type ChatTurnFinishReason,
} from "@appstrate/core/chat-turn-metadata";
import {
  classifyClientTurnError,
  clientTurnErrorMarker,
  type ClientTurnError,
} from "../turn-error.ts";

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

/** Build the persisted terminal metadata shared by every Pi exit path. */
function buildPiTurnMetadata(input: {
  finishReason: ChatTurnFinishReason;
  clientError?: ClientTurnError;
  stepCount: number;
  stepCapReached: boolean;
  lastToolName?: string;
}): ChatMessageMetadata {
  return mergeTurnMetadata(undefined, {
    finishReason: input.finishReason,
    ...(input.clientError
      ? {
          errorCategory: input.clientError.category,
          errorRetryable: input.clientError.retryable,
          ...(input.clientError.requestId ? { requestId: input.clientError.requestId } : {}),
        }
      : {}),
    stepCount: input.stepCount,
    maxSteps: CHAT_MAX_STEPS,
    toolStepBudget: CHAT_TOOL_STEP_BUDGET,
    toolStepBudgetReached: input.stepCapReached,
    maxStepsReached: input.stepCapReached,
    ...(input.lastToolName ? { lastToolName: input.lastToolName } : {}),
  });
}

/** What {@link closePiTurn} produced. */
interface PiTurnClosure {
  /** The chunks to write, in order: optional `start`, error, deadline notice, `finish`. */
  chunks: UIMessageChunk[];
  /** The turn was cut by the wall-clock ceiling — the caller logs it. */
  deadlineReached: boolean;
}

/**
 * Close a Pi chat turn — the ONE place the closing sequence happens.
 *
 * Both of the engine's exits (the loop returning, and an exception escaping
 * setup or the prompt) end the same way: classify the error, surface it as an
 * `error` chunk, resolve the closure, write the deadline notice if the ceiling
 * was reached, and finish with the turn metadata. They differed only in where
 * `finishReason` came from and whether a leading `start` was still owed, so
 * both are parameters here rather than a second copy of the sequence.
 *
 * `error` is the RAW error to surface, or `undefined` when the turn has none.
 * Suppression is the caller's call: an aborted turn passes `undefined` (a stop
 * is a normal ending), while a turn whose loop reported `finishReason: "error"`
 * passes the model's own error text even though it never threw.
 */
export function closePiTurn(input: {
  error?: unknown;
  finishReason: ChatTurnFinishReason;
  /** A `start` chunk was already written for this turn (no leading one is owed). */
  streamStarted: boolean;
  aborted: boolean;
  abortReason: unknown;
  stepCount: number;
  stepCapReached: boolean;
  lastToolName?: string;
  newId?: () => string;
}): PiTurnClosure {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const closure = resolveTurnClosure({
    aborted: input.aborted,
    abortReason: input.abortReason,
    finishReason: input.finishReason,
  });
  const clientError = input.error === undefined ? undefined : classifyClientTurnError(input.error);
  const chunks: UIMessageChunk[] = [];

  if (!input.streamStarted) chunks.push({ type: "start", messageId: newId() });
  if (clientError) {
    chunks.push({ type: "error", errorText: clientTurnErrorMarker(clientError) });
  }
  if (closure.deadlineReached) {
    chunks.push(...turnNoticeChunks(newId(), turnDeadlineNoticeText(CHAT_TURN_DEADLINE_MS)));
  }
  chunks.push({
    type: "finish",
    messageMetadata: buildPiTurnMetadata({
      finishReason: closure.finishReason,
      ...(clientError ? { clientError } : {}),
      stepCount: input.stepCount,
      stepCapReached: input.stepCapReached,
      ...(input.lastToolName ? { lastToolName: input.lastToolName } : {}),
    }),
  });
  return { chunks, deadlineReached: closure.deadlineReached };
}
