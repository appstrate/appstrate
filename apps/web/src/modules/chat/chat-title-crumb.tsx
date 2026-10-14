// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the active conversation as the last segment of the shell's trail.
 *
 * The trail is drawn ONCE, by `ShellBreadcrumb`, next to the org chip that
 * opens it — pages declare, the shell draws. So the chat declares here rather
 * than re-implementing a breadcrumb inside its own header, where the two
 * products' trails would drift apart.
 *
 * The segment is published only when the conversation is KNOWN. A cold load, or
 * a URL naming a conversation that was deleted, then costs no segment at all —
 * better than a segment carrying a made-up name. `ShellBreadcrumb` draws the
 * separator with the segment, so nothing is left dangling either way.
 *
 * A component rather than a hook call inside `ChatShell` because it must sit
 * BELOW the chat's context providers, and `ChatShell` is what puts them up.
 */

import { useMemo } from "react";
import { ChatConversationTitle, type ChatCan, type ChatTranslate } from "@appstrate/module-chat/ui";
import { useSessions } from "@appstrate/module-chat/unread";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";

export function ChatTitleCrumb({
  conversationId,
  t,
  can,
}: {
  conversationId: string | null;
  t: ChatTranslate;
  can: ChatCan;
}) {
  const { data: sessions } = useSessions();
  const session = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  const title = session ? (session.title ?? t("threads.new")) : null;
  // One element per conversation: the store keeps a trail whose node is the
  // same object, so a fresh element each render would rewrite it every render.
  const node = useMemo(
    () =>
      conversationId ? <ChatConversationTitle activeId={conversationId} t={t} can={can} /> : null,
    [conversationId, t, can],
  );

  usePageBreadcrumb(node && title !== null ? [{ label: title, node }] : []);

  return null;
}
