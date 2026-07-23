// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper only injects
// the shell's org/app scoping headers. Lazy-loaded behind `features.chat`.

import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatPage } from "@appstrate/module-chat/ui";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useSidebarStore } from "../../stores/sidebar-store";
import { DocumentPreview } from "../../components/document-preview";

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
  // Scoping headers + the active UI language, so the assistant replies in the
  // language the user actually reads (the server defaults to fr without it).
  // Reads `i18n.language` at call time — the transport invokes this per
  // request, so a language switch applies to the next send.
  const { i18n } = useTranslation();
  const getHeaders = useCallback(
    () => ({ ...buildScopingHeaders(), "X-Chat-Locale": i18n.language }),
    [i18n],
  );
  // Clicking a chat document (attachment thumbnail/chip or a run card's document
  // chip) opens the SAME in-app preview modal the documents library uses. The
  // chat module delegates via this callback (dependency direction is web →
  // module-chat, so the module can't import the preview component).
  const [previewDoc, setPreviewDoc] = useState<{ id: string; name: string } | null>(null);
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
        getHeaders={getHeaders}
        conversationId={conversationId ?? null}
        newChatKey={location.key}
        onConversationChange={onConversationChange}
        onOpenDocument={setPreviewDoc}
      />
      {previewDoc && (
        <DocumentPreview doc={previewDoc} open={!!previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
