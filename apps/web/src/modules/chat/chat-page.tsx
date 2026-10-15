// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page (`@appstrate/module-chat/ui`). With
// `chat-sidebar.tsx` it is the only importer of the module's UI, and it injects
// everything the module needs (headers, navigation, file services, translator).
// Lazy-loaded behind `features.chat`.

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
import { ShellHeaderActions } from "../../components/app-shell";
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

// One element for the page's lifetime: the composer slot is memoized by the chat.
const COMPOSER_ACTIONS = <ChatAccessChip />;

export function ChatModulePage() {
  // The agent-authoring preference is per user: bind it before the composer paints.
  const userId = useAuth().user?.id ?? null;
  useLayoutEffect(() => bindAgentAuthoringUser(userId), [userId]);
  // The id lives in the URL so a refresh restores it; `replace` keeps updates out of the back-history.
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  // The context panel starts closed; tabs and presented files open it via the reducer.
  const [sidebarState, dispatchSidebar] = useReducer(
    conversationSidebarReducer,
    INITIAL_CONVERSATION_SIDEBAR_STATE,
  );
  // `location.key` is unique per history entry: the chat mints a fresh conversation
  // id when it changes (new-chat navigation), created lazily on its first message.
  const location = useLocation();
  // The shell's list sits above this page and only changes the URL: reset the panel here.
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
  const getHeaders = useChatGetHeaders();
  const translate = useChatTranslate();
  const { can } = usePermissions();
  // Absent means allowed (opt-out setting).
  const { data: orgSettings } = useOrgSettings();
  const { data: credentials } = useModelProviderCredentials();
  const { data: registry } = useProvidersRegistry();
  const modelCredentials = useMemo(
    () => pickerCredentials(credentials ?? [], registry ?? [], userId ?? undefined),
    [credentials, registry, userId],
  );
  // No trigger/source policy on purpose: any file selection opens the same Preview tab.
  const presentFile = useCallback<OpenFile>(
    (file) => dispatchSidebar({ type: "show-file", file }),
    [],
  );

  // Back/forward bypasses the selection callback: clear on popstate so an old
  // entry never resurrects an artefact the user did not reopen.
  useEffect(() => {
    const onHistoryNavigation = () => dispatchSidebar({ type: "conversation-change" });
    window.addEventListener("popstate", onHistoryNavigation);
    return () => window.removeEventListener("popstate", onHistoryNavigation);
  }, []);
  const downloadFile = useFileDownload();
  const onDownloadFile = useCallback(
    (id: string, name: string) => void downloadFile(id, name),
    [downloadFile],
  );
  // Same uploader as SchemaForm file fields (it refreshes the org storage gauge).
  const uploadFile = useUploadClient();
  // The shell hands the chat a definite height, so the thread scrolls internally.
  // The context panel sits beside the thread (overlaying it on narrow screens);
  // its tabs are portaled into the shell header.
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
