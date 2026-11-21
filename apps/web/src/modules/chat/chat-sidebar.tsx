// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's conversation list inside the shell's shared sidebar frame. Only
 * this list is lazy-loaded with the chat UI, so loading never blanks the shell.
 * Also publishes the chat's place in the trail (`ChatTitleCrumb`).
 */

import { useCallback } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import {
  ChatConversationList,
  ChatTransportProvider,
  SelectConversationProvider,
} from "@appstrate/module-chat/ui";
import { ChatSidebarSkeleton } from "../../components/loading-skeletons";
import { ChatTitleCrumb } from "./chat-title-crumb";
import { renderSpaces } from "./render-spaces";
import { formatAge } from "../../lib/format-date";
import { useChatCan, useChatFilter, useChatTransport, useChatTranslate } from "./use-chat-runtime";

export function ChatSidebar() {
  // Layout sits above the chat's routes, so match here instead of `useParams`.
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId ?? null;
  const navigate = useNavigate();
  const transport = useChatTransport();
  const t = useChatTranslate();
  const can = useChatCan();
  const { known } = useChatFilter();
  // A conversation opens in place, whatever the list's filter; `replace` keeps conversation
  // switches out of the back-history.
  const select = useCallback(
    (id: string | null) => navigate(id ? `/chat/${id}` : "/chat", { replace: true }),
    [navigate],
  );

  // The list waits for the mode like the page: its shape, and the trail's slot, hold meanwhile.
  if (!known) {
    return (
      <>
        <ChatTitleCrumb conversationId={conversationId} pending />
        <ChatSidebarSkeleton />
      </>
    );
  }
  return (
    <ChatTransportProvider value={transport ?? null}>
      <SelectConversationProvider value={select}>
        <ChatTitleCrumb conversationId={conversationId} transport={transport} />
        <ChatConversationList
          activeId={conversationId}
          t={t}
          can={can}
          renderSpaces={renderSpaces}
          formatAge={formatAge}
        />
      </SelectConversationProvider>
    </ChatTransportProvider>
  );
}
