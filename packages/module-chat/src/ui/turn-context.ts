// SPDX-License-Identifier: Apache-2.0

/**
 * How full a conversation's context is, read from `AppstrateTurnMetadata.context`: the same
 * reading live, after a reload and after a resume. A conversation no turn measured reads `null`.
 */

import {
  turnMetadataFromMessage,
  type AppstrateTurnContext,
  type AppstrateTurnMetadata,
} from "@appstrate/core/chat-turn-metadata";
import { fractionOfWindow } from "@appstrate/ui/context-window";
import { sourceMessage } from "./turn-error-state.ts";

/** Share of the summarizing threshold from which the gauge warns: quality drops well before it. */
const NEAR_RATIO = 0.8;

/** `full`: the history is past the threshold, so the engine summarizes it before the next request. */
export type ContextLevel = "ok" | "near" | "full";

export interface ConversationContext extends AppstrateTurnContext {
  /** Share of {@link AppstrateTurnContext.compactAt}, the scale both the fill and the level use. */
  ratio: number;
  level: ContextLevel;
  /** A turn of the conversation summarized the history: what precedes its kept part is summarized. */
  summarized: boolean;
  /** The model the measure was taken with, which may not be the one selected now. */
  modelId: string | null;
  modelLabel: string | null;
}

export function contextReading(
  context: AppstrateTurnContext,
): Pick<ConversationContext, "ratio" | "level"> {
  if (context.tokens > context.compactAt) return { ratio: 1, level: "full" };
  const ratio = fractionOfWindow(context.tokens, context.compactAt);
  return { ratio, level: ratio >= NEAR_RATIO ? "near" : "ok" };
}

/** The newest measure; a turn still streaming has none, so the previous one stands. */
export function latestConversationContext(
  messages: readonly unknown[],
): ConversationContext | null {
  let measured: AppstrateTurnMetadata | null = null;
  let summarized = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const turn = turnMetadataFromMessage(sourceMessage(messages[index]));
    if (!measured && turn?.context !== undefined) measured = turn;
    if (turn?.summary !== undefined) summarized = true;
    if (measured && summarized) break;
  }
  if (!measured?.context) return null;
  return {
    ...measured.context,
    ...contextReading(measured.context),
    summarized,
    modelId: measured.modelId ?? null,
    modelLabel: measured.modelLabel ?? null,
  };
}
