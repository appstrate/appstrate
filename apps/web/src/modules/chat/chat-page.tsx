// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper is the ONLY place
// the shell imports the module, and it injects everything the module needs:
// scoping headers, navigation, the file services (preview, authenticated
// download, authenticated image preview, staged upload) and the translator.
// Lazy-loaded behind `features.chat`. The shell around it is the app's layout,
// shared with Studio and kept mounted across a product switch; the chat's own
// part of it, the conversation list, is `chat-sidebar.tsx` (the only other
// importer of the module's UI).

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ChatHeadersProvider,
  ChatPage,
  SelectConversationProvider,
  type OpenFile,
} from "@appstrate/module-chat/ui";
import { bindAgentAuthoringUser } from "@appstrate/module-chat/agent-authoring";
import { useAuth } from "../../hooks/use-auth";
import { useFileDownload, useFileImageSrc } from "../../hooks/use-files";
import { formatBytes } from "../../lib/format-bytes";
import { useUploadClient } from "../../hooks/use-upload";
import {
  INITIAL_CONVERSATION_SIDEBAR_STATE,
  conversationSidebarReducer,
} from "./conversation-sidebar-state";
import { ConversationContextActions, ConversationSidebar } from "./conversation-sidebar";
import { ShellHeaderActions } from "../../components/shell-frame";
import { useChatGetHeaders, useChatTranslate } from "./use-chat-runtime";
import { ChatAccessChip } from "./chat-access-chip";
import { readChatComposerDraft } from "../../lib/creation-handoff";
import { usePermissions } from "../../hooks/use-permissions";
import { useOrgSettings } from "../../hooks/use-org-settings";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
} from "../../hooks/use-model-provider-credentials";
import { pickerCredentials } from "../../lib/model-picker";

// One element for the page's lifetime: it sits in the composer slot, which the
// chat memoizes, and the chip keeps itself current through its own hooks.
const COMPOSER_ACTIONS = <ChatAccessChip />;

export function ChatModulePage() {
  // The agent-authoring preference is per user: bind it before the composer paints.
  const userId = useAuth().user?.id ?? null;
  useLayoutEffect(() => bindAgentAuthoringUser(userId), [userId]);
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
  // A conversation picked in the shell's list arrives as a URL change only (the
  // list lives in the layout, above this page): reset the panel the same way
  // the page's own selection does.
  const [shownConversationId, setShownConversationId] = useState(conversationId);
  if (shownConversationId !== conversationId) {
    setShownConversationId(conversationId);
    dispatchSidebar({ type: "conversation-change" });
  }
  const initialComposerDraft = readChatComposerDraft(location.state);
  const onConversationChange = useCallback(
    (id: string | null) => {
      dispatchSidebar({ type: "conversation-change" });
      navigate(id ? `/chat/${id}` : "/chat", { replace: true });
    },
    [navigate],
  );
  // The same namespace's `t` is injected into the module, so the shell AROUND
  // the answers speaks the same language too — labels and aria-labels alike.
  const getHeaders = useChatGetHeaders();
  const translate = useChatTranslate();
  const { can } = usePermissions();
  // Absent means allowed (the setting is opt-out): the chat only drops its
  // "add my credential" link once the organization has turned them off.
  const { data: orgSettings } = useOrgSettings();
  // The credentials that name the model picker's groups, as in the dashboard's pickers.
  const { data: credentials } = useModelProviderCredentials();
  const { data: registry } = useProvidersRegistry();
  const modelCredentials = useMemo(
    () => pickerCredentials(credentials ?? [], registry ?? [], userId ?? undefined),
    [credentials, registry, userId],
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
  // Its tabs sit in the shell's header, portaled there for the page's lifetime.
  return (
    <ChatHeadersProvider value={getHeaders}>
      <SelectConversationProvider value={onConversationChange}>
        <ShellHeaderActions>
          <ConversationContextActions state={sidebarState} dispatch={dispatchSidebar} />
        </ShellHeaderActions>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <ChatPage
              getHeaders={getHeaders}
              conversationId={conversationId ?? null}
              newChatKey={location.key}
              initialComposerDraft={initialComposerDraft}
              onConversationChange={onConversationChange}
              onOpenFile={presentFile}
              composerActions={COMPOSER_ACTIONS}
              downloadFile={onDownloadFile}
              useFileImageSrc={useFileImageSrc}
              uploadFile={uploadFile}
              t={translate}
              can={can}
              personalModelCredentials={orgSettings?.personal_model_credentials}
              modelCredentials={modelCredentials}
              formatBytes={formatBytes}
            />
          </div>
          <ConversationSidebar
            conversationId={conversationId ?? null}
            state={sidebarState}
            dispatch={dispatchSidebar}
          />
        </div>
      </SelectConversationProvider>
    </ChatHeadersProvider>
  );
}
