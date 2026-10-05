// SPDX-License-Identifier: Apache-2.0

/**
 * Which model answered a turn, read from `AppstrateTurnMetadata` — the one
 * source, identical live, after a reload and after a resume. A message the
 * engine did not close carries no model: `null`, never a guess.
 */

import { turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";
import { sourceMessage, turnFailed } from "./turn-error-state.ts";

/** Frozen at write time, so it still names a model whose org row is gone. */
export function turnModelLabel(message: unknown): string | null {
  return turnMetadataFromMessage(sourceMessage(message))?.modelLabel ?? null;
}

/**
 * The sentence the badge reads out. A failed turn still names its model —
 * "which model failed" is the question — but it answered nothing.
 */
export function turnModelSentenceKey(message: unknown): "model.answeredBy" | "model.failedWith" {
  return turnFailed(turnMetadataFromMessage(sourceMessage(message)))
    ? "model.failedWith"
    : "model.answeredBy";
}

function turnModelId(message: unknown): string | null {
  return turnMetadataFromMessage(sourceMessage(message))?.modelId ?? null;
}

/** The model of the newest message that carries one; may name one that no longer exists. */
export function latestTurnModelId(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = turnModelId(messages[i]);
    if (id !== null) return id;
  }
  return null;
}
