// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the active conversation as the last segment of the shell's trail.
 *
 * The trail is drawn ONCE, by `ShellBreadcrumb`, next to the org chip that
 * opens it — pages declare, the shell draws. So the chat declares here rather
 * than re-implementing a breadcrumb inside its own header, which is how the two
 * products' trails drifted apart once already.
 *
 * The segment is published only when the conversation is KNOWN. A cold load, or
 * a URL naming a conversation that was deleted, then costs no segment at all —
 * better than a segment carrying a made-up name. `ShellBreadcrumb` draws the
 * separator with the segment, so nothing is left dangling either way.
 *
 * A component rather than a hook call inside `ChatShell` because it must sit
 * BELOW the chat's context providers, and `ChatShell` is what puts them up.
 */

import { useEffect } from "react";
import { ChatConversationTitle, type ChatTranslate } from "@appstrate/module-chat/ui";
import { useSessions } from "@appstrate/module-chat/unread";
import { useBreadcrumbStore } from "@/stores/breadcrumb-store";

export function ChatTitleCrumb({
  conversationId,
  t,
}: {
  conversationId: string | null;
  t: ChatTranslate;
}) {
  const { data: sessions } = useSessions();
  const setEntries = useBreadcrumbStore((s) => s.setEntries);
  const session = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  const title = session ? (session.title ?? t("list.untitled")) : null;

  useEffect(() => {
    if (!conversationId || title === null) {
      setEntries([]);
      return;
    }
    setEntries([{ label: title, node: <ChatConversationTitle activeId={conversationId} t={t} /> }]);
    return () => setEntries([]);
  }, [conversationId, title, t, setEntries]);

  return null;
}
