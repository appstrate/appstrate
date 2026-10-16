// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's conversation list inside the shell's shared sidebar frame. Only
 * this list is lazy-loaded with the chat UI, so loading never blanks the shell.
 * Also publishes the open conversation's title to the trail (`ChatTitleCrumb`).
 */

import { useCallback } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import {
  ChatConversationList,
  ChatHeadersProvider,
  SelectConversationProvider,
} from "@appstrate/module-chat/ui";
import { usePermissions } from "../../hooks/use-permissions";
import { ChatRenameGuard } from "./rename-guard";
import { ChatTitleCrumb } from "./chat-title-crumb";
import { useChatGetHeaders, useChatTranslate } from "./use-chat-runtime";

export function ChatSidebar() {
  // Layout sits above the chat's routes, so match here instead of `useParams`.
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId ?? null;
  const navigate = useNavigate();
  const getHeaders = useChatGetHeaders();
  const t = useChatTranslate();
  const { can } = usePermissions();
  // `replace` keeps conversation switches out of the back-history.
  const select = useCallback(
    (id: string | null) => navigate(id ? `/chat/${id}` : "/chat", { replace: true }),
    [navigate],
  );

  return (
    <ChatHeadersProvider value={getHeaders}>
      <SelectConversationProvider value={select}>
        <ChatTitleCrumb conversationId={conversationId} t={t} can={can} />
        <ChatConversationList
          activeId={conversationId}
          t={t}
          can={can}
          RenameGuard={ChatRenameGuard}
        />
      </SelectConversationProvider>
    </ChatHeadersProvider>
  );
}
