// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import { useLiveConversation } from "@appstrate/module-chat/live-conversation";
import {
  conversationTools,
  type ConversationToolCall,
  type ConversationToolStatus,
} from "@appstrate/module-chat/conversation-tools";
import { showCall, type ShownCall } from "@appstrate/module-chat/tool-presentation";

/**
 * The calls of the conversation `conversationId` while shown: as the open chat holds them
 * (`useLiveConversation`), the turn in flight included, else as the server stores them.
 * `undefined` until the conversation is read (held while the panel is closed), `null` when the
 * server holds no such conversation.
 */
export function useConversationTools(conversationId: string | null, active: boolean) {
  const live = useLiveConversation(conversationId, active);
  const query = useSessionDetail(conversationId, { enabled: active && live === undefined });
  const session = query.data;
  const tools = useMemo(() => {
    if (live) return conversationTools(live.messages, { running: live.running });
    return session === undefined ? undefined : session && conversationTools(session.messages);
  }, [live, session]);
  return { tools, error: live ? null : query.error };
}

/** The call as its card in the thread shows it (`showCall`): label, target, what it acted on. */
export function useToolLabel() {
  const { t } = useTranslation("chat");
  return (call: ConversationToolCall): ShownCall =>
    showCall(
      { toolName: call.toolName, args: call.input, presentation: call.presentation },
      (key, params) => t(key, params ?? {}),
    );
}

/** Whether the calls acted in more than one space, so each row names its own. */
export function spansSpaces(calls: readonly ConversationToolCall[]): boolean {
  return new Set(calls.map((call) => call.spaceId).filter(Boolean)).size > 1;
}

/** A call's outcome in words, wherever the panel names it. */
export const TOOL_STATUS_LABEL: Record<ConversationToolStatus, string> = {
  running: "common:status.running",
  success: "context.tools.status.success",
  error: "context.tools.status.error",
  denied: "context.tools.status.denied",
};

/**
 * A call's outcome in its tone, as text: the thread's card tints a badge by phase
 * (`tool-uis.tsx`, no `denied` phase there), the panel only colours a word or a glyph.
 */
export const TOOL_STATUS_TONE: Record<ConversationToolStatus, string> = {
  running: "text-muted-foreground",
  success: "text-muted-foreground",
  error: "text-destructive",
  denied: "text-warning",
};
