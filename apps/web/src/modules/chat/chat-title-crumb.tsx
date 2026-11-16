// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the chat's place in the shell's trail, like any page: "Chat" on a new conversation,
 * "Chat / <conversation>" inside one (the parent links back to a new conversation). The name
 * is a plain segment; renaming lives in the conversation's settings dialog.
 *
 * While sessions load (or cannot be asked yet, `pending`) a skeleton slot reserves the space; an unknown (deleted) conversation
 * publishes "Chat" alone rather than a made-up name.
 */

import { useTranslation } from "react-i18next";
import { useSessions } from "@appstrate/module-chat/unread";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import { ShellTrailContent } from "@/components/shell-breadcrumb";

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
  const session = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  const title = session ? (session.title ?? t("threads.new")) : null;

  // `isLoading`: the read is off without a space, and would wait forever.
  const loading = conversationId !== null && (pending || isLoading);

  const chat = t("common:products.chat");
  usePageBreadcrumb(
    title !== null
      ? [{ label: chat, href: "/chat" }, { label: title }]
      : loading
        ? [
            { label: chat, href: "/chat" },
            { label: "", slot: true },
          ]
        : [{ label: chat }],
  );

  return loading ? (
    <ShellTrailContent>
      <Skeleton className="mx-1.5 h-4 w-40" />
    </ShellTrailContent>
  ) : null;
}
