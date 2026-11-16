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
import { useActInSpace } from "../../hooks/use-space-action";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { ChatTitleCrumb } from "./chat-title-crumb";
import { conversationOpening } from "./chat-transport";
import { renderSpaces } from "./render-spaces";
import {
  useChatCan,
  useChatCanIn,
  useChatScope,
  useChatTransport,
  useChatTranslate,
} from "./use-chat-runtime";

export function ChatSidebar() {
  // Layout sits above the chat's routes, so match here instead of `useParams`.
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId ?? null;
  const navigate = useNavigate();
  const transport = useChatTransport();
  const t = useChatTranslate();
  const can = useChatCan();
  const canIn = useChatCanIn();
  const { scope, known } = useChatScope();
  const { choose } = useOverviewMode();
  const actInSpace = useActInSpace();
  // `replace` keeps conversation switches out of the back-history. In « Vue d'ensemble », a space
  // session opens in its own space (leaving the mode); an organization session opens in place.
  const select = useCallback(
    (id: string | null, spaceId?: string | null) => {
      const open = () => navigate(id ? `/chat/${id}` : "/chat", { replace: true });
      const opening = conversationOpening(scope, id, spaceId);
      if (opening.kind === "here") return open();
      actInSpace(opening.spaceId, () => {
        choose(false);
        open();
      });
    },
    [navigate, scope, actInSpace, choose],
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
    <ChatTransportProvider value={transport}>
      <SelectConversationProvider value={select}>
        <ChatTitleCrumb conversationId={conversationId} />
        <ChatConversationList
          activeId={conversationId}
          t={t}
          can={can}
          canIn={canIn}
          renderSpaces={renderSpaces}
        />
      </SelectConversationProvider>
    </ChatTransportProvider>
  );
}
