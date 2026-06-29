// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper only injects
// the shell's org/app scoping headers. Lazy-loaded behind `features.chat`.

import { useCallback, useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ChatPage } from "@appstrate/module-chat/ui";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useSidebarStore } from "../../stores/sidebar-store";

export function ChatModulePage() {
  // Auto-collapse the global sidebar while in chat, restore on leave (same
  // pattern as settings/profile). Transient setter leaves the user's persisted
  // preference untouched.
  useEffect(() => {
    const { open, setOpenTransient } = useSidebarStore.getState();
    const prev = open;
    setOpenTransient(false);
    return () => {
      useSidebarStore.getState().setOpenTransient(prev);
    };
  }, []);
  // Conversation id lives in the URL (`/chat/:conversationId`) so a refresh or
  // deep-link restores the open conversation. `replace` keeps message/title
  // updates out of the back-history.
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  // `location.key` is unique per history entry. The chat mints a fresh
  // conversation id whenever it changes (a new-chat navigation: "+", the nav
  // link, or deleting the active one), so a brand-new conversation is created
  // lazily on its first message (ChatGPT-style) without ever resurfacing the
  // previous one on a bare `/chat`.
  const location = useLocation();
  const onConversationChange = useCallback(
    (id: string | null) => navigate(id ? `/chat/${id}` : "/chat", { replace: true }),
    [navigate],
  );
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module, which is a hard peer requirement of `chat` (enforced at
  // boot) — so tools are always available when the chat is reachable.
  // Bound the chat to the viewport height below the app shell's h-16 header so
  // the thread scrolls internally and the composer stays pinned (sticky) at the
  // bottom. Without a definite height here the flex chain grows with the message
  // list and the composer scrolls off-screen.
  return (
    <div className="h-[calc(100dvh-4rem)] min-h-0">
      <ChatPage
        getHeaders={buildScopingHeaders}
        conversationId={conversationId ?? null}
        newChatKey={location.key}
        onConversationChange={onConversationChange}
      />
    </div>
  );
}
