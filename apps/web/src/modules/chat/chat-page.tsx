// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper is the ONLY place
// the shell imports the module, and it injects everything the module needs:
// scoping headers, navigation, the file services (preview, authenticated
// download, authenticated image preview, staged upload) and the translator.
// Lazy-loaded behind `features.chat`, together with the shell it mounts
// (`chat-shell.tsx`, the only other importer of the module's UI — it mounts the
// two pieces that belong to the shell rather than to the thread).

import { useCallback, useEffect, useReducer } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatPage, type OpenFile } from "@appstrate/module-chat/ui";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useViewAsHeader } from "../../stores/view-as-store";
import { useCollapsedGlobalSidebar } from "../../hooks/use-collapsed-global-sidebar";
import { useFileDownload, useFileImageSrc } from "../../hooks/use-files";
import { useUploadClient } from "../../hooks/use-upload";
import {
  INITIAL_CONVERSATION_SIDEBAR_STATE,
  conversationSidebarReducer,
} from "./conversation-sidebar-state";
import { ConversationContextActions, ConversationSidebar } from "./conversation-sidebar";
import { ChatShell } from "./chat-shell";
import { readChatComposerDraft } from "../../lib/creation-handoff";

export function ChatModulePage() {
  useCollapsedGlobalSidebar();
  // Conversation id lives in the URL (`/chat/:conversationId`) so a refresh or
  // deep-link restores the open conversation. `replace` keeps message/title
  // updates out of the back-history.
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  // Context starts closed on every viewport. Selecting a context tab or
  // presenting any file (including the single file a run just produced)
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
  const initialComposerDraft = readChatComposerDraft(location.state);
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
  // The persona is read reactively and threaded through so this callback's
  // identity changes when the preview starts or ends. The module's SSE effects
  // depend on `getHeaders`, and a stream reads its URL once — without this they
  // would keep tailing under the authority the preview replaced.
  const viewAs = useViewAsHeader();
  const getHeaders = useCallback(
    () => ({ ...buildScopingHeaders(viewAs), "X-Chat-Locale": i18n.language }),
    [i18n, viewAs],
  );
  const translate = useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params ?? {}),
    [t],
  );
  // One presentation interface for both direct clicks and the automatic
  // presentation of a run's single produced file. There is intentionally no
  // trigger/source policy here: selecting a file always opens the same
  // Preview tab in the same sidebar.
  const presentFile = useCallback<OpenFile>(
    (file) => dispatchSidebar({ type: "show-file", file }),
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
  // File services the module consumes instead of reimplementing: the typed
  // download (reports failures with a toast) and the typed image preview.
  const downloadFile = useFileDownload();
  const onDownloadFile = useCallback(
    (id: string, name: string) => void downloadFile(id, name),
    [downloadFile],
  );
  // The very same uploader every SchemaForm file field uses — including its
  // refresh of the org storage gauge. The chat composer stages files through
  // it instead of re-implementing the 2-step upload.
  const uploadFile = useUploadClient();
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module, which is a hard peer requirement of `chat` (enforced at
  // boot) — so tools are always available when the chat is reachable.
  //
  // The shell hands the chat a definite height (its inset never scrolls), so
  // the thread scrolls internally and the composer stays pinned at the bottom.
  // The context panel is a sibling of the thread, INSIDE the shell's content
  // area: it belongs to the conversation, and it overlays it on narrow screens.
  return (
    <ChatShell
      getHeaders={getHeaders}
      conversationId={conversationId ?? null}
      onConversationChange={onConversationChange}
      headerActions={<ConversationContextActions state={sidebarState} dispatch={dispatchSidebar} />}
      t={translate}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          <ChatPage
            getHeaders={getHeaders}
            conversationId={conversationId ?? null}
            newChatKey={location.key}
            initialComposerDraft={initialComposerDraft}
            onConversationChange={onConversationChange}
            onOpenFile={presentFile}
            downloadFile={onDownloadFile}
            useFileImageSrc={useFileImageSrc}
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
    </ChatShell>
  );
}
