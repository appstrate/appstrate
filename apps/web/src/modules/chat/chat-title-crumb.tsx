// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the chat's place in the shell's trail, like any page: "Chat" on a new conversation,
 * "Chat / <conversation>" inside one (the parent links back to a new conversation).
 *
 * The segment is a slot: the title is rendered HERE, below the chat's context
 * providers it reads, and portalled into the header (which sits outside them).
 * While sessions load a skeleton reserves the space; an unknown (deleted)
 * conversation publishes "Chat" alone rather than a made-up name.
 */

import { ChatConversationTitle, type ChatCan, type ChatTranslate } from "@appstrate/module-chat/ui";
import { useSessions } from "@appstrate/module-chat/unread";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import { ShellTrailContent } from "@/components/shell-breadcrumb";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useTranslation } from "react-i18next";

export function ChatTitleCrumb({
  conversationId,
  t,
  can,
}: {
  conversationId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  const { t: tCommon } = useTranslation("common");
  const { data: sessions, isLoading } = useSessions();
  const session = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  const title = session ? (session.title ?? t("threads.new")) : null;

  // `isLoading`: the read is off without a space, and would wait forever.
  const loading = conversationId !== null && isLoading;

  const chat = tCommon("products.chat");
  usePageBreadcrumb(
    title !== null
      ? [
          { label: chat, href: "/chat" },
          { label: title, slot: true },
        ]
      : loading
        ? [
            { label: chat, href: "/chat" },
            { label: "", slot: true },
          ]
        : [{ label: chat }],
  );

  if (loading) {
    return (
      <ShellTrailContent>
        <Skeleton className="mx-1.5 h-4 w-40" />
      </ShellTrailContent>
    );
  }
  return conversationId && title !== null ? (
    <ShellTrailContent>
      <ChatConversationTitle activeId={conversationId} t={t} can={can} />
    </ShellTrailContent>
  ) : null;
}
