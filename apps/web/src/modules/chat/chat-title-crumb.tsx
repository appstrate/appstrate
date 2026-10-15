// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the active conversation as the last segment of the shell's trail.
 *
 * The trail is drawn ONCE, by `ShellBreadcrumb`, next to the org chip that
 * opens it — pages declare, the shell draws. So the chat declares here rather
 * than re-implementing a breadcrumb inside its own header, where the two
 * products' trails would drift apart.
 *
 * The segment is a slot: the title (with its rename) is rendered HERE, below the
 * chat's context providers it reads, and portalled into the header. Rendered by
 * the header itself it would sit outside them, with no headers to fetch with.
 *
 * While the sessions are being read the segment is reserved with a bar, so the
 * trail does not grow when they land. Once read, the segment is published only
 * when the conversation is KNOWN: a URL naming a conversation that was deleted
 * costs no segment at all — better than a segment carrying a made-up name.
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
  const { data: sessions, isPending } = useSessions();
  const session = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  const title = session ? (session.title ?? t("threads.new")) : null;

  const loading = conversationId !== null && isPending;

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
