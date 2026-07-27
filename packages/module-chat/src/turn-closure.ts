// SPDX-License-Identifier: Apache-2.0

/**
 * How a chat turn CLOSES, and what the user is told about it — engine-neutral.
 *
 * Both engines fold a user stop and the turn's wall-clock ceiling
 * (`CHAT_TURN_DEADLINE_MS`) into a single `AbortController`. Tagging the
 * deadline with {@link ChatTurnDeadlineError} is what lets the finish path tell
 * them apart: a user stop is a normal ending (the user already knows), a
 * deadline is a truncation the user must be told about, in a REAL text part
 * (`text-start`/`text-delta`/`text-end`). An `error` chunk would not do — error
 * chunks are transient and never become persisted message parts, which is
 * exactly how a 10-minute turn once ended as an empty message.
 *
 * These primitives were born on the Pi engine (`pi-chat/turn-control.ts`) but
 * describe the shared contract, not that engine: the ai-sdk path enforces the
 * same ceiling and closes the turn the same way. They live here so there is ONE
 * home for the rule — the step-cap controller, which really is Pi-specific,
 * stays in `pi-chat/turn-control.ts`.
 */

import type { UIMessageChunk } from "ai";
import type { ChatTurnFinishReason } from "@appstrate/core/chat-turn-metadata";

/**
 * Abort reason marking an engine's wall-clock ceiling (as opposed to the user
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
 * surfaces its error (the engines' standing invariant), and claiming "time
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
