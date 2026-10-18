// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the active conversation as the last segment of the shell's trail.
 *
 * The segment is a slot: the title is rendered HERE, below the chat's context
 * providers it reads, and portalled into the header (which sits outside them).
 * While sessions load a skeleton reserves the space; an unknown (deleted)
 * conversation publishes no segment rather than a made-up name.
 */

import { ChatConversationTitle, type ChatCan, type ChatTranslate } from "@appstrate/module-chat/ui";
import { useSessions } from "@appstrate/module-chat/unread";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import { ShellTrailContent } from "@/components/shell-breadcrumb";
import { Skeleton } from "@appstrate/ui/components/skeleton";

export function ChatTitleCrumb({
  conversationId,
  t,
  can,
}: {
  conversationId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  const { data: sessions, isLoading } = useSessions();
  const session = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  const title = session ? (session.title ?? t("threads.new")) : null;

  // `isLoading`: the read is off without a space, and would wait forever.
  const loading = conversationId !== null && isLoading;

  usePageBreadcrumb(
    title !== null ? [{ label: title, slot: true }] : loading ? [{ label: "", slot: true }] : [],
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
