// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper is the ONLY place
// the shell imports the module, and it injects everything the module needs:
// scoping headers, navigation, the document services (preview, authenticated
// download, authenticated image preview, staged upload) and the translator.
// Lazy-loaded behind `features.chat`.

import { useCallback, useEffect, useReducer } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatPage, type OpenDocument } from "@appstrate/module-chat/ui";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useSidebarStore } from "../../stores/sidebar-store";
import { useDocumentDownload, useDocumentImageSrc } from "../../hooks/use-documents";
import { useUploadClient } from "../../hooks/use-upload";
import {
  INITIAL_CONVERSATION_SIDEBAR_STATE,
  conversationSidebarReducer,
} from "./conversation-sidebar-state";
import { ConversationContextActions, ConversationSidebar } from "./conversation-sidebar";

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
  // Context starts closed on every viewport. Selecting a context tab or
  // presenting any document (including a newly published primary output)
  // expands it through the reducer's single action path.
  const [sidebarState, dispatchSidebar] = useReducer(
    conversationSidebarReducer,
    INITIAL_CONVERSATION_SIDEBAR_STATE,
  );
  // `location.key` is unique per history entry. The chat mints a fresh
  // conversation id whenever it changes (a new-chat navigation: "+", the nav
  // link, or deleting the active one), so a brand-new conversation is created
  // lazily on its first message (ChatGPT-style) without ever resurfacing the
  // previous one on a bare `/chat`.
  const location = useLocation();
  const onConversationChange = useCallback(
    (id: string | null) => {
      dispatchSidebar({ type: "conversation-change" });
      navigate(id ? `/chat/${id}` : "/chat", { replace: true });
    },
    [navigate],
  );
  // Scoping headers + the active UI language, so the assistant replies in the
  // language the user actually reads (the server defaults to fr without it).
  // Reads `i18n.language` at call time — the transport invokes this per
  // request, so a language switch applies to the next send.
  //
  // The same namespace's `t` is injected into the module, so the shell AROUND
  // those answers speaks the same language too — labels and aria-labels alike.
  const { t, i18n } = useTranslation("chat");
  const getHeaders = useCallback(
    () => ({ ...buildScopingHeaders(), "X-Chat-Locale": i18n.language }),
    [i18n],
  );
  const translate = useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params ?? {}),
    [t],
  );
  // One presentation interface for both direct clicks and automatic primary
  // outputs. There is intentionally no trigger/source policy here: selecting a
  // document always opens the same Preview tab in the same sidebar.
  const presentDocument = useCallback<OpenDocument>(
    (document) => dispatchSidebar({ type: "show-document", document }),
    [],
  );

  // Browser back/forward bypasses the chat's selection callback. Clear from the
  // popstate callback (not an effect body) so returning to an old entry never
  // resurrects an artefact the user did not explicitly reopen.
  useEffect(() => {
    const onHistoryNavigation = () => dispatchSidebar({ type: "conversation-change" });
    window.addEventListener("popstate", onHistoryNavigation);
    return () => window.removeEventListener("popstate", onHistoryNavigation);
  }, []);
  // Document services the module consumes instead of reimplementing: the typed
  // download (reports failures with a toast) and the typed image preview.
  const downloadDocument = useDocumentDownload();
  const onDownloadDocument = useCallback(
    (id: string, name: string) => void downloadDocument(id, name),
    [downloadDocument],
  );
  // The very same uploader every SchemaForm file field uses — including its
  // refresh of the org storage gauge. The chat composer stages files through
  // it instead of re-implementing the 2-step upload.
  const uploadFile = useUploadClient();
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module, which is a hard peer requirement of `chat` (enforced at
  // boot) — so tools are always available when the chat is reachable.
  // Bound the chat to the viewport height below the app shell's h-16 header so
  // the thread scrolls internally and the composer stays pinned (sticky) at the
  // bottom. Without a definite height here the flex chain grows with the message
  // list and the composer scrolls off-screen.
  return (
    <div
      data-full-bleed
      className="relative flex h-[calc(100dvh-var(--spacing-header))] min-h-0 min-w-0"
    >
      <div className="min-w-0 flex-1">
        <ChatPage
          getHeaders={getHeaders}
          conversationId={conversationId ?? null}
          newChatKey={location.key}
          onConversationChange={onConversationChange}
          onOpenDocument={presentDocument}
          headerActions={
            <ConversationContextActions state={sidebarState} dispatch={dispatchSidebar} />
          }
          downloadDocument={onDownloadDocument}
          useDocumentImageSrc={useDocumentImageSrc}
          uploadFile={uploadFile}
          t={translate}
        />
      </div>
      <ConversationSidebar
        conversationId={conversationId ?? null}
        state={sidebarState}
        dispatch={dispatchSidebar}
      />
    </div>
  );
}
