// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's navigation, as the shell's sidebar draws it.
 *
 * The chat is a PRODUCT beside Studio, not a page inside it, so it does not
 * borrow Studio's navigation — where Studio lists Activité/Construire, the chat
 * lists conversations. But the frame around that list (brand cell, product
 * tabs, header, realtime stream) is the ONE frame both products share, mounted
 * by the app's layout and kept mounted when switching between them. Only this
 * list is the chat's, and it is lazy-loaded with the chat module's UI, inside
 * the frame — so loading it never blanks the shell.
 *
 * It also publishes the open conversation's title to the shell's trail
 * (`ChatTitleCrumb`), which reads the same sessions query the list does.
 */

import { useCallback } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import {
  ChatConversationList,
  ChatHeadersProvider,
  SelectConversationProvider,
} from "@appstrate/module-chat/ui";
import { usePermissions } from "../../hooks/use-permissions";
import { ChatTitleCrumb } from "./chat-title-crumb";
import { useChatGetHeaders, useChatTranslate } from "./use-chat-runtime";

export function ChatSidebar() {
  // The layout sits above the chat's routes, so the id is matched here rather
  // than read from `useParams`.
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId ?? null;
  const navigate = useNavigate();
  const getHeaders = useChatGetHeaders();
  const t = useChatTranslate();
  const { can } = usePermissions();
  // Same navigation as the page's own: `replace` keeps conversation switches out
  // of the back-history. The page resets its context panel on the id change.
  const select = useCallback(
    (id: string | null) => navigate(id ? `/chat/${id}` : "/chat", { replace: true }),
    [navigate],
  );

  return (
    <ChatHeadersProvider value={getHeaders}>
      <SelectConversationProvider value={select}>
        <ChatTitleCrumb conversationId={conversationId} t={t} can={can} />
        <ChatConversationList activeId={conversationId} t={t} can={can} />
      </SelectConversationProvider>
    </ChatHeadersProvider>
  );
}
