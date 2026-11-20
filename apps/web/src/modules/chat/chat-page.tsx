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
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ChatConversationSettingsButton,
  ChatPage,
  ChatTransportProvider,
  SelectConversationProvider,
  type AttachTarget,
  type OpenFile,
  type SpaceChoiceMenu,
} from "@appstrate/module-chat/ui";
import { bindChatPreferencesUser } from "@appstrate/module-chat/preferences";
import { useAuth } from "../../hooks/use-auth";
import { useFirstName } from "../../hooks/use-first-name";
import { useFileDownload, useFileImageSrc } from "../../hooks/use-files";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId, useSpaceLink } from "../../hooks/use-current-space";
import { useRowSpaceGrants } from "../../hooks/use-permissions";
import { otherSpaceFileContext } from "../../lib/file-link";
import { ChatConversationSkeleton, ChatPanelSkeleton } from "../../components/loading-skeletons";
import { formatBytes } from "../../lib/format-bytes";
import { useViewAs } from "../../stores/view-as-store";
import { useUploadInSpace } from "../../hooks/use-upload";
import {
  INITIAL_CONVERSATION_SIDEBAR_STATE,
  conversationSidebarReducer,
  heldLocalUrl,
} from "./conversation-sidebar-state";
import { ConversationContextToggle, ConversationSidebar } from "./conversation-sidebar";
import { ShellHeaderActions } from "../../components/shell-header-slots";
import { ConversationSpaces } from "./conversation-spaces";
import { renderSpaces } from "./render-spaces";
import { SpaceChoiceSubmenu } from "../../components/space-choice-menu";
import {
  useChatActingSpaceIds,
  useChatCan,
  useChatFilter,
  useChatTransport,
  useChatTranslate,
} from "./use-chat-runtime";
import { useOwnPersonalSpaceId, useSpaceLabelOf, useSpacesOf } from "../../hooks/use-spaces";
import { readChatComposerDraft } from "../../lib/creation-handoff";
import { useOrgSettings } from "../../hooks/use-org-settings";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
} from "../../hooks/use-model-provider-credentials";
import { pickerCredentials } from "../../lib/model-picker";
import { refreshPackageLists } from "../../hooks/use-mutations";

export function ChatModulePage() {
  // The composer's preferences are per user: bind them before the composer paints.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const firstName = useFirstName();
  useLayoutEffect(() => bindChatPreferencesUser(userId), [userId]);
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
  const transport = useChatTransport();
  const translate = useChatTranslate();
  const { i18n } = useTranslation();
  const { known } = useChatFilter();
  // What the chat may do is judged over the spaces it acts in, not the working one.
  const can = useChatCan();
  // A call's grant is judged in the space the call acted in.
  const canIn = useRowSpaceGrants();
  const actingSpaceIds = useChatActingSpaceIds();
  // Every file attached from the computer goes to the caller's own personal space.
  const { spaceId: personalSpaceId, failed: spacesFailed } = useOwnPersonalSpaceId();
  // A role preview holds no personal space: attaching is unavailable for good, not loading.
  const previewing = useViewAs() !== null;
  const attachTarget = useMemo<AttachTarget>(
    () =>
      personalSpaceId
        ? { spaceId: personalSpaceId }
        : { unavailable: previewing ? "preview" : spacesFailed ? "error" : "loading" },
    [personalSpaceId, previewing, spacesFailed],
  );
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
    (file) =>
      dispatchSidebar({
        type: "show-file",
        file: "local" in file ? { local: file.local, url: URL.createObjectURL(file.local) } : file,
      }),
    [],
  );
  // A picked file's object URL lives while the panel holds it. The panel starts empty, so
  // Strict Mode's replay of the first run has nothing to revoke.
  const localUrl = heldLocalUrl(sidebarState);
  useEffect(() => (localUrl ? () => URL.revokeObjectURL(localUrl) : undefined), [localUrl]);

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
  // A file of another space (a call of a conversation) is read in its own.
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  // A run a conversation launched opens in its space, entering it when it is not this one.
  const linkInSpace = useSpaceLink();
  const onDownloadFile = useCallback(
    (id: string, name: string, spaceId?: string) =>
      void downloadFile(id, name, otherSpaceFileContext(spaceId, orgId, currentSpaceId)),
    [downloadFile, orgId, currentSpaceId],
  );
  // The very same uploader every SchemaForm file field uses — including its
  // refresh of the org storage gauge — into the space the chat names for each file.
  const uploadFile = useUploadInSpace();
  const queryClient = useQueryClient();
  // The assistant creates and imports packages: the lists show them as the editor's would.
  const onPackagesChanged = useCallback(() => refreshPackageLists(queryClient), [queryClient]);
  // The mode decides which conversations the list holds: until it is known the page holds its shape.
  if (!known) return conversationId ? <ChatConversationSkeleton /> : <ChatPanelSkeleton />;
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module, which is a hard peer requirement of `chat` (enforced at
  // boot) — so tools are always available when the chat is reachable.
  //
  // The shell hands the chat a definite height (its inset never scrolls), so
  // the thread scrolls internally and the composer stays pinned at the bottom.
  // The context panel is a sibling of the thread, INSIDE the shell's content
  // area: it belongs to the conversation, and it opens in a sheet on narrow screens.
  // One toggle sits in the shell's header, portaled there for the page's lifetime;
  // the tabs live in the panel's own header.
  return (
    <ChatTransportProvider value={transport ?? null}>
      <SelectConversationProvider value={onConversationChange}>
        <ShellHeaderActions>
          <ConversationSpaces conversationId={conversationId ?? null} transport={transport} />
          <ChatConversationSettingsButton
            activeId={conversationId ?? null}
            t={translate}
            can={can}
          />
          <ConversationContextToggle expanded={sidebarState.expanded} dispatch={dispatchSidebar} />
        </ShellHeaderActions>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <ChatPage
              transport={transport}
              conversationId={conversationId ?? null}
              newChatKey={location.key}
              initialComposerDraft={initialComposerDraft}
              onConversationChange={onConversationChange}
              onOpenFile={presentFile}
              downloadFile={onDownloadFile}
              useFileImageSrc={useFileImageSrc}
              uploadFile={uploadFile}
              t={translate}
              can={can}
              canIn={canIn}
              actingSpaceIds={actingSpaceIds}
              attachTarget={attachTarget}
              personalModelCredentials={orgSettings?.personal_model_credentials}
              modelCredentials={modelCredentials}
              formatBytes={formatBytes}
              lang={i18n.language}
              onPackagesChanged={onPackagesChanged}
              firstName={firstName || null}
              renderSpaces={renderSpaces}
              linkInSpace={linkInSpace}
              useSpaceLabelOf={useSpaceLabelOf}
              SpaceChoiceMenu={ChatSpaceChoiceMenu}
            />
          </div>
          <ConversationSidebar
            conversationId={conversationId ?? null}
            state={sidebarState}
            dispatch={dispatchSidebar}
          />
        </div>
      </SelectConversationProvider>
    </ChatTransportProvider>
  );
}

/** The chat's « in which space? » menu: the app's own, from a menu entry. */
const ChatSpaceChoiceMenu: SpaceChoiceMenu = ({ label, spaceIds, onPick, trigger, testId }) => {
  const spaces = useSpacesOf(spaceIds);
  return (
    <SpaceChoiceSubmenu
      choice={{ label, spaces, onPick }}
      trigger={trigger}
      marks={testId ? { "data-testid": testId } : undefined}
    />
  );
};
