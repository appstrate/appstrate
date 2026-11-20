// SPDX-License-Identifier: Apache-2.0

/**
 * How full a conversation's context is, read from `AppstrateTurnMetadata.context`
 * — the one source, identical live, after a reload and after a resume. The
 * engine measures it on each turn's last settled model call; nothing here
 * estimates. A conversation no turn measured reads `null`, never a zero.
 */

import {
  turnMetadataFromMessage,
  type AppstrateTurnContext,
} from "@appstrate/core/chat-turn-metadata";
import { sourceMessage } from "./turn-error-state.ts";

/**
 * Share of the compaction threshold from which the gauge warns. The quality of
 * a long context degrades well before its limit, and the threshold — not the
 * window — is where the engine starts summarizing.
 */
const NEAR_RATIO = 0.8;

/**
 * `ok` below {@link NEAR_RATIO} of the threshold, `near` from it, `full` once
 * the next request crosses it (the engine summarizes the history first, or the
 * provider may refuse a request over its window when compaction is off).
 */
export type ContextLevel = "ok" | "near" | "full";

export interface ConversationContext extends AppstrateTurnContext {
  /** `tokens / window`, clamped to [0, 1]. */
  ratio: number;
  level: ContextLevel;
  /** The preset the measure was taken with — may differ from the one now selected. */
  modelId: string | null;
  modelLabel: string | null;
}

function isTurnContext(value: unknown): value is AppstrateTurnContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tokens === "number" &&
    typeof v.window === "number" &&
    v.window > 0 &&
    (v.compactAt === undefined || typeof v.compactAt === "number")
  );
}

/** The gauge's reading of one measure. */
export function contextReading(
  context: AppstrateTurnContext,
): Pick<ConversationContext, "ratio" | "level"> {
  const ratio = Math.min(1, Math.max(0, context.tokens / context.window));
  const threshold = context.compactAt ?? context.window;
  const level: ContextLevel =
    context.tokens >= threshold ? "full" : context.tokens >= threshold * NEAR_RATIO ? "near" : "ok";
  return { ratio, level };
}

/**
 * The newest message's measure: the context the conversation's next request
 * carries. A turn still streaming has none yet, so the previous turn's measure
 * stands until it closes.
 */
export function latestConversationContext(
  messages: readonly unknown[],
): ConversationContext | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const turn = turnMetadataFromMessage(sourceMessage(messages[i]));
    const context = turn?.context;
    if (!isTurnContext(context)) continue;
    return {
      ...context,
      ...contextReading(context),
      modelId: turn?.modelId ?? null,
      modelLabel: turn?.modelLabel ?? null,
    };
  }
  return null;
}
