// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the chat's place in the shell's trail, like any page: "Chat" on a new conversation,
 * "Chat / <conversation>" inside one (the parent links back to a new conversation). The name
 * is a plain segment; renaming lives in the conversation's « … » menu. Published by the chat page,
 * mounted on every format (the list is not: a phone's drawer unmounts it while closed).
 *
 * The name is the open conversation's server row (`useActiveSession`): a conversation belongs to
 * the organization, so one opened from outside the list's space filter keeps its name. The spaces
 * it touched are not part of the trail: the conversation's « … » names them.
 *
 * While sessions load (or cannot be asked yet, `pending`) a skeleton slot reserves the space; an unknown (deleted) conversation
 * publishes "Chat" alone rather than a made-up name.
 */

import { useIsFetching } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ChatTransport } from "@appstrate/module-chat/ui";
import { useActiveSession, useSessions } from "@appstrate/module-chat/unread";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import { ShellTrailContent } from "@/components/shell-breadcrumb";
import { chatTrailEntries } from "./chat-crumb-title";

export function ChatTitleCrumb({
  conversationId,
  transport,
  pending = false,
}: {
  conversationId: string | null;
  transport?: ChatTransport;
  /** The sessions cannot be asked yet (the scope they are read in is not known): the slot is reserved. */
  pending?: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const { isLoading } = useSessions(transport);
  const row = useActiveSession(
    transport,
    conversationId ?? "",
    conversationId !== null && !pending,
  );
  // The conversation's own read, made when the list lacks its row.
  const reading =
    useIsFetching({
      queryKey: [
        "get",
        "/api/orgs/{orgId}/chat/sessions/{id}",
        { params: { path: { id: conversationId } } },
      ],
    }) > 0;
  const title = row ? (row.title ?? t("threads.new")) : null;
  const loading = conversationId !== null && !row && (pending || isLoading || reading);

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
