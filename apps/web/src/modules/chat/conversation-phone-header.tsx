// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat puts in its phone header (below `md`), after the shell's burger: the conversation's
 * name, truncated, « Nouvelle conversation » on a new one; then what the desktop's header carries
 * through `ShellHeaderActions`, in its order: the spaces the conversation touched, the pencil that
 * edits the name, the context panel. Controls are 44 px.
 */

import type { Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { ChatConversationRenameButton, type ChatTransport } from "@appstrate/module-chat/ui";
import { useActiveSession } from "@appstrate/module-chat/unread";
import { ShellHeaderPhone } from "../../components/shell-header-slots";
import type { ConversationSidebarAction } from "./conversation-sidebar-state";
import { ConversationContextToggle } from "./conversation-sidebar";
import { ConversationSpaces } from "./conversation-spaces";
import type { useChatCan, useChatTranslate } from "./use-chat-runtime";

/** Controls in a phone's header are as big as a thumb. */
const PHONE_HEADER_BUTTON_CLASS = "size-11 shrink-0";

export function ConversationPhoneBar({
  conversationId,
  transport,
  translate,
  can,
  expanded,
  dispatch,
}: {
  conversationId: string | null;
  transport: ChatTransport | undefined;
  translate: ReturnType<typeof useChatTranslate>;
  can: ReturnType<typeof useChatCan>;
  expanded: boolean;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const row = useActiveSession(transport, conversationId ?? "", conversationId !== null);
  const loading = conversationId !== null && !row;
  return (
    <>
      {loading ? (
        <Skeleton className="mx-1 h-5 min-w-0 flex-1" />
      ) : (
        <h1
          className="min-w-0 flex-1 truncate text-base font-semibold"
          data-testid="conversation-phone-title"
        >
          {row?.title ?? t("threads.new")}
        </h1>
      )}
      <ConversationSpaces conversationId={conversationId} transport={transport} className="h-11" />
      <ChatConversationRenameButton
        activeId={conversationId}
        t={translate}
        can={can}
        className={PHONE_HEADER_BUTTON_CLASS}
      />
      <ConversationContextToggle
        expanded={expanded}
        dispatch={dispatch}
        className={PHONE_HEADER_BUTTON_CLASS}
      />
    </>
  );
}

/** {@link ConversationPhoneBar} in the shell's phone header. */
export function ConversationPhoneHeader(props: Parameters<typeof ConversationPhoneBar>[0]) {
  return (
    <ShellHeaderPhone>
      <ConversationPhoneBar {...props} />
    </ShellHeaderPhone>
  );
}
