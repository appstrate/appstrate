// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import {
  conversationTools,
  type ConversationToolCall,
  type ConversationTools,
} from "@appstrate/module-chat/conversation-tools";
import { toolPresentation } from "@appstrate/module-chat/tool-presentation";
import { useIntegrationsById } from "../../hooks/use-integrations";

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

export interface ToolCallLabel {
  title: string;
  target?: string;
  /** The logo of the integration the call reached (`null`: it has none); absent for other calls. */
  logo?: string | null;
}

/**
 * The call's name, as its card in the thread names it, except a call reaching a readable
 * integration: named after that integration, with its logo. The integrations are read once for
 * all of `tools`, the read the summary's integration line makes.
 */
export function useToolLabel(tools: ConversationTools | null) {
  const { t } = useTranslation("chat");
  const ids = useMemo(() => (tools?.integrations ?? []).map((use) => use.packageId), [tools]);
  const { data } = useIntegrationsById(ids);
  const rows = new Map((data ?? []).map((row) => [row.id, row] as const));
  return (call: ConversationToolCall): ToolCallLabel => {
    const { labelKey, label, target } = toolPresentation(call.toolName, call.input);
    const integration = call.integrationPackageId ? rows.get(call.integrationPackageId) : undefined;
    if (integration) {
      return {
        title: integration.manifest.display_name ?? integration.id,
        target,
        logo: integration.manifest.icon ?? null,
      };
    }
    return { title: labelKey ? t(labelKey) : (label ?? call.toolName), target };
  };
}

/** Whether the calls acted in more than one space, so each row names its own. */
export function spansSpaces(calls: readonly ConversationToolCall[]): boolean {
  return new Set(calls.map((call) => call.spaceId).filter(Boolean)).size > 1;
}
