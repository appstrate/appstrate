// SPDX-License-Identifier: Apache-2.0

/**
 * What the chat puts in its phone header (below `md`), after the shell's burger: the conversation's
 * name, truncated, « Nouvelle conversation » on a new one; the pencil that edits the name; and, at
 * the right end, the context panel. The desktop's header is the shell's own and carries the
 * spaces, the settings and the context through `ShellHeaderActions`.
 */

import { useState, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { PencilIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { ChatConversationSettingsDialog, type ChatTransport } from "@appstrate/module-chat/ui";
import { useActiveSession } from "@appstrate/module-chat/unread";
import { ShellHeaderPhone } from "../../components/shell-header-slots";
import type { ConversationSidebarAction } from "./conversation-sidebar-state";
import { ConversationContextToggle } from "./conversation-sidebar";
import type { useChatCan, useChatTranslate } from "./use-chat-runtime";

/** Controls in a phone's header are as big as a thumb. */
export const PHONE_HEADER_BUTTON_CLASS = "size-11 shrink-0";

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
  const [renaming, setRenaming] = useState(false);
  const row = useActiveSession(transport, conversationId ?? "", conversationId !== null);
  const loading = conversationId !== null && !row;
  const canRename = conversationId !== null && can("chat:write") && !!row;
  return (
    <>
      {loading ? (
        <Skeleton className="mx-1 h-5 min-w-0 flex-1" />
      ) : (
        <h1
          className="min-w-0 flex-1 truncate text-base font-semibold"
          data-testid="conversation-phone-title"
        >
          {conversationId === null ? t("threads.new") : (row?.title ?? t("threads.new"))}
        </h1>
      )}
      {canRename && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={PHONE_HEADER_BUTTON_CLASS}
          aria-label={t("conversation.rename")}
          onClick={() => setRenaming(true)}
        >
          <PencilIcon />
        </Button>
      )}
      <ConversationContextToggle
        expanded={expanded}
        dispatch={dispatch}
        className={PHONE_HEADER_BUTTON_CLASS}
      />
      {renaming && (
        <ChatConversationSettingsDialog
          activeId={conversationId}
          t={translate}
          can={can}
          onClose={() => setRenaming(false)}
        />
      )}
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
