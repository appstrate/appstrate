// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's record, read from the turn metadata its stored messages carry: the models that
 * closed its turns, and the context its last measured turn carried.
 */

import { turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";
import { sourceMessage, turnFailed } from "./turn-error-state.ts";
import { latestConversationContext, type ConversationContext } from "./turn-context.ts";

export interface ConversationModelUse {
  modelId: string;
  /** The display name the newest of its turns froze. */
  label: string;
  turns: number;
  /** Of those, the turns that failed (`turnFailed`): they answered nothing, or were cut short. */
  failed: number;
}

export interface ConversationStats {
  /** In order of first use. */
  models: ConversationModelUse[];
  context: ConversationContext | null;
}

export function conversationStats(messages: readonly unknown[]): ConversationStats {
  const models = new Map<string, ConversationModelUse>();
  for (const message of messages) {
    const turn = turnMetadataFromMessage(sourceMessage(message));
    if (!turn?.modelId) continue;
    const use = models.get(turn.modelId) ?? {
      modelId: turn.modelId,
      label: "",
      turns: 0,
      failed: 0,
    };
    use.label = turn.modelLabel ?? turn.modelId;
    use.turns += 1;
    if (turnFailed(turn)) use.failed += 1;
    models.set(turn.modelId, use);
  }
  return { models: [...models.values()], context: latestConversationContext(messages) };
}
