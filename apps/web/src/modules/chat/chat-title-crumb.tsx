// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the chat's place in the shell's trail, like any page: "Chat" on a new conversation,
 * "Chat / <conversation>" inside one (the parent links back to a new conversation). The name
 * is a plain segment; renaming lives in the conversation's settings dialog.
 *
 * The name comes from the conversation list while it holds the row (renames and the first title land
 * there live) and from the conversation itself otherwise: a conversation belongs to the organization,
 * so one opened from outside the list's space filter keeps its name. The spaces it touched are not
 * part of the trail: `ConversationSpaces` draws them in the header's actions.
 *
 * While sessions load (or cannot be asked yet, `pending`) a skeleton slot reserves the space; an unknown (deleted) conversation
 * publishes "Chat" alone rather than a made-up name.
 */

import { useTranslation } from "react-i18next";
import { useSessions } from "@appstrate/module-chat/unread";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import { ShellTrailContent } from "@/components/shell-breadcrumb";
import { chatTrailEntries, resolveCrumbTitle } from "./chat-crumb-title";
import { useChatSessionDetail } from "./use-chat-session-detail";

export function ChatTitleCrumb({
  conversationId,
  pending = false,
}: {
  conversationId: string | null;
  /** The sessions cannot be asked yet (the scope they are read in is not known): the slot is reserved. */
  pending?: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const { data: sessions, isLoading } = useSessions();
  const listed = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  // The conversation itself, whatever the list's filter: its name when the list lacks the row.
  const detail = useChatSessionDetail(conversationId, !pending);
  const title = resolveCrumbTitle(listed, detail.data, t("threads.new"));

  // `isLoading` is the sessions list's; the conversation's own read only matters when the list lacks the row.
  const loading =
    conversationId !== null && (pending || isLoading || (!listed && detail.isLoading));

  const chat = t("common:products.chat");
  usePageBreadcrumb(chatTrailEntries(chat, title, loading));

  if (title === null && loading) {
    return (
      <ShellTrailContent>
        <Skeleton className="mx-1.5 h-4 w-40" />
      </ShellTrailContent>
    );
  }
  return null;
}
