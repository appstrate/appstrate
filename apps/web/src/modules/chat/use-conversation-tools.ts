// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import {
  conversationTools,
  type ConversationToolCall,
} from "@appstrate/module-chat/conversation-tools";
import { toolPresentation } from "@appstrate/module-chat/tool-presentation";

/** The calls of the conversation `conversationId`, read from its stored messages while shown. */
export function useConversationTools(conversationId: string | null, active: boolean) {
  const query = useSessionDetail(active ? conversationId : null);
  const session = query.data;
  const tools = useMemo(
    () => (session ? conversationTools(session.messages, session.generating) : null),
    [session],
  );
  return { tools, isLoading: query.isLoading, error: query.error };
}

/** The call's name, as its card in the thread names it. */
export function useToolLabel() {
  const { t } = useTranslation("chat");
  return (call: ConversationToolCall) => {
    const { labelKey, label, target } = toolPresentation(call.toolName, call.input);
    return { title: labelKey ? t(labelKey) : (label ?? call.toolName), target };
  };
}

/** Whether the calls acted in more than one space, so each row names its own. */
export function spansSpaces(calls: readonly ConversationToolCall[]): boolean {
  return new Set(calls.map((call) => call.spaceId).filter(Boolean)).size > 1;
}
