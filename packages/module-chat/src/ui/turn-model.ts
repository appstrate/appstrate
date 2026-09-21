// SPDX-License-Identifier: Apache-2.0

/**
 * Which model answered a turn — read back from the persisted turn metadata.
 *
 * ONE source: `AppstrateTurnMetadata.modelId` / `.modelLabel`, stamped by
 * `closePiTurn` on every exit and carried on the assistant message's
 * `metadata`. That rides the live stream (the `finish` chunk) and the stored
 * `content` alike, so a message shows the same model once its turn has
 * finished live, after a reload, and after a resume — no second channel, no
 * reconciliation. While a turn is still streaming it has no badge yet.
 *
 * Both readers degrade to `null` rather than to a guess: every message written
 * before this shipped carries neither field, and neither does a message the
 * engine did not close (a server-authored notice). Rendering "unknown model"
 * there would be an invention; rendering nothing is the truth.
 */

import { turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";
import { sourceMessage } from "./turn-error-state.ts";

/**
 * Display name of the model that answered, or `null`.
 *
 * Frozen at write time, so it still names the model after the org row is gone
 * — which is the whole reason the label is persisted next to the id instead of
 * being resolved from `/api/models` at render time.
 */
export function turnModelLabel(message: unknown): string | null {
  return turnMetadataFromMessage(sourceMessage(message))?.modelLabel ?? null;
}

/**
 * Preset id of the model that answered, or `null`. MAY name a model that no
 * longer exists — callers use it to re-seed a picker and must tolerate a miss.
 */
export function turnModelId(message: unknown): string | null {
  return turnMetadataFromMessage(sourceMessage(message))?.modelId ?? null;
}

/**
 * The model a conversation is on: the NEWEST message carrying one.
 *
 * Scans from the end and stops at the first hit — a conversation that switched
 * models is on the model of its last turn, not its first. Messages with no
 * metadata (every user turn, every server-authored notice, everything written
 * before this shipped) are skipped rather than treated as a reset.
 */
export function latestTurnModelId(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = turnModelId(messages[i]);
    if (id !== null) return id;
  }
  return null;
}
