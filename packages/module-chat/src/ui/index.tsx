// SPDX-License-Identifier: Apache-2.0

/**
 * Chat module UI — exported from `@appstrate/module-chat/ui`.
 *
 * Architecture (AI-SDK-native, ChatGPT-style):
 *  - The URL is the single source of truth for the active conversation. The host
 *    passes `conversationId` (route param) + `onConversationChange` (navigate).
 *  - Exactly ONE `useChat` per conversation, keyed by id, wrapped into an
 *    assistant-ui runtime via `useAISDKRuntime`. Switching conversations remounts
 *    the keyed `<Conversation>` with fresh history — no thread-list lifecycle, no
 *    local→remote thread races.
 *  - The SERVER is the single writer of messages (user turn before inference,
 *    assistant turn on finalize). The client never persists; it only reads
 *    history to seed `useChat` and renders the live stream.
 *  - Mid-inference reload resumes live tokens via `useChat({ resume: true })` →
 *    `GET /api/orgs/:orgId/chat/sessions/:id/stream`.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { ConversationSkeleton } from "./conversation-skeleton.tsx";
import { THREAD_SIDE_PADDING_CLASS } from "./phone-text.ts";
import { useLatest } from "./use-latest.ts";
import { recordUploadResolutions } from "./upload.ts";
import { Thread } from "./thread.tsx";
import { createMessageQueue } from "./message-queue.ts";
import {
  ChatTransportProvider,
  ChatHostProvider,
  SelectConversationProvider,
  useChatHost,
} from "./runtime-context.ts";
import type {
  ChatCan,
  ChatHost,
  ChatTranslate,
  ChatTransport,
  OpenFile,
  SelectConversation,
  UploadFile,
  UseFileImageSrc,
} from "./runtime-context.ts";
export type {
  AttachTarget,
  ChatCan,
  ChatRequest,
  ChatTranslate,
  ChatTransport,
  GetHeaders,
  OpenFile,
  OpenFileTarget,
  RenderSpaces,
  SelectConversation,
} from "./runtime-context.ts";
export { ChatConversationList, ChatConversationRenameButton } from "./thread-list.tsx";
export { ChatTransportProvider, SelectConversationProvider } from "./runtime-context.ts";
import { ModelPickerProvider, type ModelPickerProps } from "./model-picker.ts";
import { modelSizing } from "./model-fit.ts";
import { fetchModelsEnvelope, selectChatModels, type OrgModelOption } from "./models-data.ts";
import {
  markSessionRead,
  mintSessionId,
  patchSessionsCache,
  sessionQuery,
  sessionQueryKey,
  sessionSeedQuery,
  sessionsQueryKey,
  SESSIONS_QUERY_KEY,
  startTurnRow,
  stopSession,
  type SessionHistory,
  type SessionsCache,
} from "./sessions.ts";
import { useActiveSession } from "./use-sessions.ts";
import {
  createTurnTransport,
  selectedOriginSpaceId,
  turnBody,
  type ConversationCreation,
} from "./chat-route.ts";
import { useConversationLimit } from "./conversation-limit.ts";
import {
  ConversationScopeProvider,
  useConversationScope,
  conversationTurnCan,
} from "./conversation-scope.ts";
import {
  subscribeGeneration,
  subscribeModel,
  attachConversation,
  getCompatibleGenerationSettings,
  getSelectedModel,
  editGenerationSettings,
  setModelCatalog,
  setSelectedModel,
} from "./model-store.ts";
import { getPackageAuthoringEnabled } from "./package-authoring-store.ts";
import { getContextAllSpacesEnabled } from "./context-all-spaces-store.ts";
import { getInlineRunModelEnabled } from "./inline-run-model-store.ts";
import { latestTurnModelId } from "./turn-model.ts";
import { ComposerTools } from "./composer-tools.tsx";
import { canAuthorPackages, canPinSkills } from "../capabilities.ts";
import { createChatAttachmentAdapter } from "./attachment-adapter.ts";
import { shouldReconcileHistory } from "./history-reconcile.ts";
import { sendWithDirectives } from "./directive-send.ts";
import {
  ConversationSkillsProvider,
  useConversationSkills,
  type ConversationSkillsState,
} from "./use-conversation-skills.ts";

// Tab visibility as an external store — the mark-read effect must not fire
// while the tab is hidden: SSE-driven invalidations refetch the list even in
// background tabs, and marking a conversation read the user is not looking at
// would silently clear the unread badge on every device.
const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const getVisible = () => document.visibilityState === "visible";

/**
 * The chat model catalog under the shell's typed-client key for `GET /api/models`
 * (`[method, path, { params: { header } }]`, org-scoped): one cache entry for both sides, so a
 * catalog change the shell invalidates (model added, credential paired, auto-seed) refetches
 * the chat's too, and neither fetches what the other holds. The entry holds the raw envelope;
 * the chat narrows it with `select`.
 */
function modelsQueryKey(orgId: string | undefined) {
  return ["get", "/api/models", { params: { header: { "X-Org-Id": orgId } } }] as const;
}
/** A catalog change (credential added/revoked) is rare; re-entering `/chat` is not. */
const MODELS_STALE_MS = 60_000;
/** Stable empty list so the composer slot memo below does not miss on `undefined`. */
const EMPTY_MODELS: OrgModelOption[] = [];

export interface ChatPageProps {
  /**
   * The scoping headers and the request function (see `ChatTransport`). Memoise it: rebuild it
   * only when what it carries changes (the scoping, the list filter).
   */
  transport?: ChatTransport;
  /**
   * Active conversation id (`chs_…`) from the host URL, or `null`/`undefined`
   * for the "new conversation" state (bare `/chat`). The host wires this to a
   * route param so a refresh restores the same conversation.
   */
  conversationId?: string | null;
  /**
   * Opaque token that changes on every host "new-chat" navigation (e.g. the
   * router's `location.key`). While `conversationId` is null, a fresh
   * conversation id is minted and held stable until this token changes — so the
   * first message won't flip the runtime key (the URL then adopts that id), yet
   * "+"/nav/delete each start a fresh conversation. Router-agnostic: the module
   * never imports a router; the host supplies the signal.
   */
  newChatKey?: string;
  /**
   * Optional text staged in a brand-new conversation's composer. The module
   * never sends it: the reader can edit or discard the handoff before sending.
   */
  initialComposerDraft?: string;
  /**
   * Called when the active conversation changes (selection, new thread, or when
   * a brand-new conversation is created lazily on its first message). The host
   * navigates its URL.
   */
  onConversationChange?: SelectConversation;
  /**
   * Presents a clicked chat file — or the single file a live run produced —
   * through the host's in-app viewer. Delivered
   * to deep tool UIs via context, not props.
   */
  onOpenFile: OpenFile;
  /**
   * REQUIRED host services — the chat implements none of them itself (see
   * `runtime-context.ts`): the authenticated image
   * preview hook, the staged uploader, and the translator for user-facing text.
   */
  useFileImageSrc: UseFileImageSrc;
  uploadFile: UploadFile;
  t: ChatTranslate;
  /** The caller's grants (see `ChatCan`). Pass a stable function. */
  can: ChatCan;
  /** The caller's grants in a named space (see `ChatHost`). Pass a stable function. */
  canIn: ChatHost["canIn"];
  /** The spaces the chat acts in, `null` until known (see `ChatHost`). Pass a stable array. */
  actingSpaceIds: ChatHost["actingSpaceIds"];
  /** Where an attached file goes, or why it cannot (see `ChatHost`). Pass a stable value. */
  attachTarget: ChatHost["attachTarget"];
  /** Whether the organization allows personal model credentials, `undefined` until known (see `ChatHost`). */
  personalModelCredentials: boolean | undefined;
  /** The credentials naming the model picker's groups (see `ChatHost`). Pass a stable array. */
  modelCredentials: ChatHost["modelCredentials"];
  /** Renders a byte count in the host's language. Pass a stable function. */
  formatBytes: ChatHost["formatBytes"];
  /** The host's UI language (see `ChatHost`). */
  lang: ChatHost["lang"];
  /** Refreshes the host's package lists (see `ChatHost`). Pass a stable function. */
  onPackagesChanged: ChatHost["onPackagesChanged"];
  /** The user's first name, greeted on a new conversation (see `ChatHost`). */
  firstName?: ChatHost["firstName"];
  /** Names spaces (see `ChatHost`). Pass a stable function. */
  renderSpaces: ChatHost["renderSpaces"];
  /** Links a path in a row's space (see `ChatHost`). Pass a stable function. */
  linkInSpace: ChatHost["linkInSpace"];
  /** Names a space in plain text (see `ChatHost`). Pass a stable hook. */
  useSpaceLabelOf: ChatHost["useSpaceLabelOf"];
}

export function ChatPage({
  transport,
  conversationId,
  newChatKey,
  initialComposerDraft,
  onConversationChange,
  onOpenFile,
  useFileImageSrc,
  uploadFile,
  t,
  can,
  canIn,
  actingSpaceIds,
  attachTarget,
  personalModelCredentials,
  modelCredentials,
  formatBytes,
  lang,
  onPackagesChanged,
  firstName,
  renderSpaces,
  linkInSpace,
  useSpaceLabelOf,
}: ChatPageProps) {
  // The conversation the runtime is bound to. A persisted conversation's id
  // comes from the URL and wins; for a brand-new one (bare `/chat`) we mint an
  // id and keep it stable until the host signals a new-chat navigation
  // (`newChatKey` changes). The conversation is created lazily, server-side, on
  // its first message (ChatGPT-style) — at which point the URL adopts THIS id,
  // so the `??` short-circuits and the runtime key never flips under the send.
  // `newChatKey` is intentionally a dependency though the body never reads it:
  // its change is the signal to re-mint a fresh conversation id on a new-chat
  // navigation. (Statically "unnecessary", semantically required.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activeId = useMemo(() => conversationId ?? mintSessionId(), [conversationId, newChatKey]);
  // Whether the active conversation already exists server-side (its id is in the
  // URL). A not-yet-persisted conversation is known-empty → skip its history GET.
  const isPersisted = conversationId != null;

  // The model catalog is a React Query, not a per-mount fetch: leaving and
  // re-entering `/chat` within `staleTime` reuses the cached list instead of
  // re-hitting `/api/models` at exactly the moment the composer is trying to
  // become usable. No org scope in the key — the shell wipes the whole cache
  // on org switch (`queryClient.removeQueries`), the same contract the
  // session list relies on. A failed GET rejects (see `fetchModels`), so an
  // outage is an error state React Query retries — never an empty catalog
  // served as fresh for `staleTime`.
  const modelsQuery = useQuery({
    queryKey: modelsQueryKey(transport?.orgId),
    queryFn: () => fetchModelsEnvelope(transport!.request),
    select: selectChatModels,
    enabled: !!transport,
    staleTime: MODELS_STALE_MS,
  });
  const models = modelsQuery.data ?? EMPTY_MODELS;
  const modelsPending = modelsQuery.isPending;
  const modelsFailed = modelsQuery.isError;
  // Model selection lives in an external store (localStorage-backed), not React
  // state: the transport's header builder reads it per request through a stable
  // function (see ConversationInner), so a switch applies to the very next send
  // without remounting the conversation. This hook only mirrors it for the picker.
  const selectedModel = useSyncExternalStore(subscribeModel, getSelectedModel, getSelectedModel);
  const generation = useSyncExternalStore(
    subscribeGeneration,
    getCompatibleGenerationSettings,
    getCompatibleGenerationSettings,
  );

  // Runs on every catalog change (first load, refetch after `staleTime`), not
  // just on mount — a cached list served on re-entry still has to reconcile
  // the selection. External-store sync in an effect (no setState).
  useEffect(() => {
    if (modelsQuery.data) setModelCatalog(modelsQuery.data);
  }, [modelsQuery.data]);

  // Unread replies for conversations the user left mid-generation. `unread` is
  // server-computed (read-state lives in `chat_sessions`, shared across
  // devices); the list stays fresh via the `chat_session_update` SSE signal.
  // There is no toast — the pill is the only notification.
  const activeRow = useActiveSession(transport, activeId, isPersisted);
  // The list is read under the host's space filter, and so is its cache key (see `sessions.ts`).
  const filterSpaceId = transport?.spaceId ?? null;
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(subscribeVisibility, getVisible, getVisible);

  // Self-healing mark-read: whenever the server reports the OPEN conversation
  // unread (on open, or when a reply finalizes while the user is watching),
  // patch the cache read immediately (clears badge + dots, and guards against
  // re-firing) then persist via PUT. Gated on tab visibility — a background
  // tab receives SSE-driven refetches too, and must not mark read what the
  // user is not looking at; `visible` flipping true re-runs the effect. A
  // failed PUT self-heals on the next signal/refetch; a duplicate PUT from a
  // refetch landing mid-flight is idempotent (monotonic marker) server-side.
  // External-system sync in an effect (no setState) — React Compiler-safe.
  const canWrite = can("chat:write");
  useEffect(() => {
    // Marking read is a write (`chat:write`); a read-only caller keeps the dot.
    if (!visible || !canWrite || !transport || !activeRow?.unread) return;
    queryClient.setQueryData<SessionsCache>(sessionsQueryKey(filterSpaceId), (prev) =>
      patchSessionsCache(prev, (rows) =>
        rows.map((s) => (s.id === activeId ? { ...s, unread: false } : s)),
      ),
    );
    queryClient.setQueryData<SessionHistory | null>(
      sessionQueryKey(transport.orgId, activeId),
      (prev) => prev && { ...prev, unread: false },
    );
    void markSessionRead(transport, activeId).catch(() => {});
  }, [activeRow?.unread, activeId, transport, filterSpaceId, queryClient, visible, canWrite]);

  // The host services, published as ONE value (see `runtime-context.ts`). Every
  // member is a stable host function, so this object is referentially stable
  // between renders and consumers re-render no more than with a context each.
  const selectedPreset = models.find((model) => model.id === selectedModel);
  const modelLabel = selectedPreset?.label ?? selectedPreset?.modelId ?? null;
  const selectedSizing = useMemo(
    () => (selectedPreset ? modelSizing(selectedPreset) : null),
    [selectedPreset],
  );
  const host = useMemo<ChatHost>(
    () => ({
      openFile: onOpenFile,
      useFileImageSrc,
      t,
      can,
      canIn,
      actingSpaceIds,
      attachTarget,
      personalModelCredentials,
      modelCredentials,
      formatBytes,
      lang,
      onPackagesChanged,
      firstName,
      modelId: selectedModel,
      modelLabel,
      modelSizing: selectedSizing,
      renderSpaces,
      linkInSpace,
      useSpaceLabelOf,
    }),
    [
      onOpenFile,
      useFileImageSrc,
      t,
      can,
      canIn,
      actingSpaceIds,
      attachTarget,
      personalModelCredentials,
      modelCredentials,
      formatBytes,
      lang,
      onPackagesChanged,
      firstName,
      selectedModel,
      modelLabel,
      selectedSizing,
      renderSpaces,
      linkInSpace,
      useSpaceLabelOf,
    ],
  );

  // Built once per catalog/selection change, NOT per `ChatPage` render: this
  // page re-renders on every session-list refetch (SSE frame, safety-net poll,
  // the local-first row patch on send), and an inline object here would hand
  // `ModelPickerProvider` a new value each time and re-render every reader. The
  // setters are stable module functions, so the deps are exactly the values
  // the picker displays.
  const modelPicker = useMemo<ModelPickerProps>(
    () => ({
      models,
      selectedId: selectedModel,
      onSelect: setSelectedModel,
      generation,
      onGenerationChange: editGenerationSettings,
      pending: modelsPending,
      failed: modelsFailed,
    }),
    [models, selectedModel, generation, modelsPending, modelsFailed],
  );

  // The active row reduced to primitives so the memoised `Conversation` re-renders only when
  // they change (a few times per turn), not on every list refetch. `generating` and `updatedAt`
  // feed the history self-heal in `ConversationInner` (see `history-reconcile.ts`); the origin and
  // the limit are the stored ones `useConversationLimit` reads.
  const serverGenerating = activeRow?.generating;
  const serverUpdatedAt = activeRow?.updatedAt;
  const storedSpaceId = activeRow?.spaceId;
  const storedRestricted = activeRow?.restricted;

  return (
    <ChatTransportProvider value={transport ?? null}>
      <SelectConversationProvider value={onConversationChange ?? null}>
        <ChatHostProvider value={host}>
          <ModelPickerProvider value={modelPicker}>
            {/* The conversation list and the conversation settings are NOT here:
              they are the shell's navigation and header actions, mounted by
              the host from `ChatConversationList` /
              `ChatConversationRenameButton`. What is left is the thread itself. */}
            {/* A plain div, not a `main`: the host shell's inset already IS the
              page's `main` landmark, and two nested ones name two pages. */}
            <div className="bg-canvas flex size-full min-h-0 min-w-0 flex-col overflow-hidden">
              <Conversation
                key={activeId}
                id={activeId}
                transport={transport}
                isPersisted={isPersisted}
                initialComposerDraft={isPersisted ? undefined : initialComposerDraft}
                onConversationChange={onConversationChange}
                uploadFile={uploadFile}
                canWrite={canWrite}
                serverGenerating={serverGenerating}
                serverUpdatedAt={serverUpdatedAt}
                storedSpaceId={storedSpaceId}
                storedRestricted={storedRestricted}
              />
            </div>
          </ModelPickerProvider>
        </ChatHostProvider>
      </SelectConversationProvider>
    </ChatTransportProvider>
  );
}

interface ConversationProps {
  id: string;
  transport?: ChatTransport;
  isPersisted: boolean;
  initialComposerDraft?: string;
  onConversationChange?: SelectConversation;
  /** The host's uploader, which the conversation's attachment adapter stages files through. */
  uploadFile: UploadFile;
  /** `chat:write`: the composer placeholder and the not-found screen's new-conversation action. */
  canWrite: boolean;
  /** Server session row `generating`, from the list or the conversation; `undefined` = no row. */
  serverGenerating: boolean | undefined;
  /** Server session row `updatedAt`, from the list or the conversation; `undefined` = no row. */
  serverUpdatedAt: string | undefined;
  /** Server session row origin space; `undefined` = no row. */
  storedSpaceId: string | null | undefined;
  /** Server session row limit; `undefined` = no row. */
  storedRestricted: boolean | undefined;
}

/**
 * Loads a conversation's history, then mounts the runtime once seeded. Gating on
 * the history load keeps `useChat`'s initial `messages` correct (the option is
 * read once at mount, not reactive). A not-yet-persisted conversation is
 * known-empty, so we skip the GET entirely (`enabled: false`) and seed `[]`
 * immediately — no speculative 404, no composer flash.
 *
 * `memo`: `ChatPage` re-renders on every session-list refetch, and this subtree
 * hosts the streaming runtime. Every prop is either a primitive (`id`,
 * `isPersisted`, the `server*` / `stored*` fields of the active row), a host
 * value the host memoises (`onConversationChange`, `uploadFile`, and `transport`,
 * rebuilt when the list filter changes), so a list refetch that leaves the active row
 * untouched is a no-op here.
 */
const Conversation = memo(function Conversation({
  id,
  transport,
  isPersisted,
  canWrite,
  storedSpaceId,
  storedRestricted,
  ...rest
}: ConversationProps) {
  // Freeze persistence at mount. The runtime key (`id`) is stable across the
  // lazy URL adoption, so this component does NOT remount when `isPersisted`
  // flips false→true on the first send. If we read the live prop, that flip
  // would enable+fire the history query, whose pending state would trip the
  // loading gate below and UNMOUNT the in-flight runtime — destroying the
  // streaming turn. A conversation that started new stays "load-free" for its
  // whole life; only a deep-linked (persisted-at-mount) one loads history.
  const [persistedAtMount] = useState(isPersisted);
  const host = useChatHost();
  const { t, actingSpaceIds } = host;
  const queryClient = useQueryClient();
  const history = useQuery({
    ...sessionSeedQuery(queryClient, transport, id),
    enabled: persistedAtMount,
  });

  // The conversation's origin space and limit: the session row's once it exists, the selected
  // space and a local choice before its first message (see `conversation-limit.ts`).
  const { scope, getCreation } = useConversationLimit({
    id,
    transport,
    persistedAtMount,
    stored:
      storedRestricted === undefined
        ? undefined
        : { spaceId: storedSpaceId ?? null, restricted: storedRestricted },
    selectedSpaceId: selectedOriginSpaceId(transport, actingSpaceIds),
    generating: rest.serverGenerating === true,
  });

  // Stable identity: `ConversationInner` keys its store-attach effect on it.
  const initialMessages = useMemo(() => history.data?.messages ?? [], [history.data?.messages]);

  // No picker on a failed read: it would show the defaults, and a change would
  // send them over the stored choice.
  const turnCan = conversationTurnCan(scope, host);
  const authorsPackages = canAuthorPackages(turnCan);
  const showPicker = canPinSkills(turnCan) && !history.isError;
  // The session detail's skills once the server holds the row, a local selection before. Gated
  // here for the turn (`turnSkills` bypasses the provider) and below for what the thread shows.
  const conversationSkills = useConversationSkills({
    transport,
    id,
    persisted: persistedAtMount,
    enabled: showPicker,
  });
  const tools = <ComposerTools authorsPackages={authorsPackages} />;

  if (persistedAtMount && history.isPending) {
    return (
      <ConversationSkeleton
        label={t("conversation.loading")}
        placeholder={turnCan("chat:write") ? t("composer.placeholder") : null}
        disclaimer={t("thread.disclaimer")}
      />
    );
  }
  // No composer on a 404: the server would create a session under that id.
  // Mount-persisted only — the reconcile writes a refused first send's 404 into
  // this same entry, and that conversation must keep its message and error.
  if (persistedAtMount && history.data === null) {
    return <ConversationNotFound canWrite={canWrite} onNew={rest.onConversationChange} />;
  }
  return (
    <ConversationScopeProvider value={scope}>
      {/* The panel, the `/` menu's skills and the thread's pin action, where the selection can change. */}
      <ConversationSkillsProvider value={showPicker ? conversationSkills : null}>
        <ConversationInner
          id={id}
          transport={transport}
          isPersisted={persistedAtMount}
          initialMessages={initialMessages}
          composerTools={tools}
          turnSkills={conversationSkills}
          getCreation={getCreation}
          {...rest}
        />
      </ConversationSkillsProvider>
    </ConversationScopeProvider>
  );
});

function ConversationNotFound({
  canWrite,
  onNew,
}: {
  canWrite: boolean;
  onNew: SelectConversation | undefined;
}) {
  const { t } = useChatHost();
  return (
    <div
      role="status"
      data-testid="chat-conversation-not-found"
      className={cn(
        "flex h-full flex-col items-center justify-center gap-3 text-center",
        THREAD_SIDE_PADDING_CLASS,
      )}
    >
      <p className="text-sm font-medium">{t("conversation.notFound.title")}</p>
      <p className="text-muted-foreground max-w-sm text-sm">{t("conversation.notFound.hint")}</p>
      {canWrite && onNew ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onNew(null)}>
          {t("threads.new")}
        </Button>
      ) : null}
    </div>
  );
}

function ConversationInner({
  id,
  transport,
  initialMessages,
  isPersisted,
  initialComposerDraft,
  onConversationChange,
  uploadFile,
  composerTools,
  serverGenerating,
  serverUpdatedAt,
  turnSkills,
  getCreation,
}: Omit<ConversationProps, "canWrite" | "storedSpaceId" | "storedRestricted"> & {
  composerTools: React.ReactNode;
  initialMessages: UIMessage[];
  /** The skills a first turn creates the conversation with. */
  turnSkills: Pick<ConversationSkillsState, "takeForTurn">;
  /** The origin space and limit the turn being sent creates the conversation with. */
  getCreation: () => ConversationCreation | undefined;
}) {
  const queryClient = useQueryClient();
  const { t, attachTarget } = useChatHost();
  const scope = useConversationScope();
  const { takeForTurn } = turnSkills;
  // File attachments: the composer stages picked files through the HOST uploader, into the
  // caller's personal space, as `upload://` file parts the server materializes into durable
  // files of the conversation.
  const getAttachTarget = useLatest(attachTarget);
  const attachments = useMemo(
    () =>
      createChatAttachmentAdapter({
        upload: uploadFile,
        t,
        attachTarget: getAttachTarget,
      }),
    [uploadFile, t, getAttachTarget],
  );
  const filterSpaceId = transport?.spaceId ?? null;
  // Read when the turn starts (the row it creates), not a reason to re-run the effect below.
  const getScope = useLatest(scope);
  // The transport read at request time for the same reason: `useChat` keeps the first one it saw.
  const getTransport = useLatest(transport);
  // The seed, frozen: `useChat` reads it once.
  const [seedMessages] = useState(initialMessages);

  // Pre-select the model of this conversation's newest turn. A layout effect,
  // so the composer never paints one frame of the stored default first.
  useLayoutEffect(() => {
    attachConversation(id, latestTurnModelId(seedMessages));
  }, [id, seedMessages]);

  // Detach on unmount, in its own effect so a re-run above never drops a pick.
  useLayoutEffect(() => () => attachConversation(null, null), []);

  // Header builder invoked by the transport at request/reconnect time. It reads
  // the model from the external store, NOT from React state: `useChat` recreates
  // its `Chat` instance only when `id` changes, so a transport rebuilt over
  // fresh state would be silently ignored and every send would keep the model
  // captured at mount. The store read resolves per request, so a model switch
  // applies to the next send.
  const buildHeaders = useCallback((): Record<string, string> => {
    const model = getSelectedModel();
    return {
      ...getTransport()?.getHeaders(),
      ...(model ? { "X-Model-Id": model } : {}),
    };
  }, [getTransport]);

  const turnTransport = useMemo(
    () =>
      createTurnTransport({
        getTransport,
        headers: buildHeaders,
        // Read at request time, like the model above, for the same reason.
        body: ({ id: chatId, messages, body }) => {
          return turnBody({
            body,
            id: chatId,
            messages,
            generation: getCompatibleGenerationSettings(),
            packageAuthoring: getPackageAuthoringEnabled(),
            inlineRunsUseChatModel: getInlineRunModelEnabled(),
            contextAllSpaces: getContextAllSpacesEnabled(),
            skills: takeForTurn(),
            creation: getCreation(),
          });
        },
      }),
    [buildHeaders, takeForTurn, getCreation, getTransport],
  );

  const chat = useChat({
    id,
    messages: seedMessages,
    transport: turnTransport,
    // Reconnect to an in-flight turn on mount (mid-inference reload). 204 when
    // nothing is generating → no-op.
    //
    // Gated on `isPersisted` (which the parent pins to its mount-time value): a
    // conversation the client just minted has no server row, so the resume GET
    // is a guaranteed 204. Spending a request on that answer competes for
    // connections with the model list and the session list at exactly the
    // moment the composer is trying to become usable.
    // …and on the host's transport being there: the resume GET needs the organization's route.
    resume: isPersisted && !!transport,
    // One React commit per animation frame (16 ms) instead of one per stream
    // chunk. The SDK applies this to the `messages` subscription only
    // (`useChat` passes it to `~registerMessagesCallback`); `status` is a
    // separate, unthrottled subscription, so "submitted → streaming → ready"
    // still lands the instant it happens. A frame is the floor that stays
    // invisible: the markdown smoothing (`markdown-text.tsx`) reveals text at
    // a paced rate from a backlog, so frame-sized deliveries feed that
    // backlog continuously, where a 50 ms batch reads as a pulse. Each chunk
    // still structured-clones the in-flight message
    // (`ReactChatState.replaceMessage`) — this only bounds how often the
    // thread re-renders and re-parses on top of that.
    throttle: 16,
    // The stored file each just-sent attachment became, so its chip opens before a reload.
    onData: recordUploadResolutions,
  });

  // History ↔ resume self-heal: the history GET and the resume GET are both
  // one-shot, so a turn that finalizes between them leaves this thread ending
  // on the user message with nothing to ever fetch the reply. When the server
  // row reports the conversation idle at a `updatedAt` we have not reconciled
  // (`shouldReconcileHistory` holds the full rule), refetch history and — only
  // if it is LONGER than what the runtime holds — swap it in with
  // `setMessages`. No remount: `useChat` keeps its `Chat` instance while `id`
  // is unchanged, and `setMessages` writes straight to its state. The ref
  // records the `updatedAt` each attempt ran at so a turn that ended without a
  // reply (server-side failure) costs one GET per server change, not a loop.
  const lastReconciledUpdatedAt = useRef<string | null>(null);
  const { status: chatStatus, messages: chatMessages, setMessages } = chat;
  useEffect(() => {
    if (
      !shouldReconcileHistory({
        status: chatStatus,
        serverGenerating,
        serverUpdatedAt,
        localMessages: chatMessages,
        lastReconciledUpdatedAt: lastReconciledUpdatedAt.current,
      })
    ) {
      return;
    }
    // `serverUpdatedAt` is defined here (the rule returns false otherwise).
    lastReconciledUpdatedAt.current = serverUpdatedAt ?? null;
    if (!transport) return;
    let cancelled = false;
    void queryClient
      .fetchQuery({
        ...sessionQuery(transport, id),
        // The mounted history query pins `staleTime: Infinity`; force the GET.
        staleTime: 0,
      })
      .then((fetched) => {
        if (cancelled || !fetched || fetched.messages.length <= chatMessages.length) return;
        setMessages(fetched.messages);
      })
      .catch(() => {
        // Best-effort: the next server change re-arms the rule.
      });
    return () => {
      cancelled = true;
    };
  }, [
    chatStatus,
    chatMessages,
    serverGenerating,
    serverUpdatedAt,
    setMessages,
    queryClient,
    transport,
    id,
  ]);

  // LOCAL-FIRST sidebar state for this conversation. The turn's lifecycle is
  // known right here (`chat.status`) — waiting for the server round-trip
  // (NOTIFY → SSE → refetch) leaves the spinner blind for seconds: the server
  // only sets its `generating` marker AFTER the inference preamble (model
  // select + MCP boot). So on every send we patch our own row into the cache
  // (spinner on, fresh timestamp, moved to the top — the list is
  // updatedAt-desc, so this mirrors the server ordering and also creates the
  // row for a brand-new conversation the server hasn't persisted yet). When
  // the turn settles we flip the spinner off and invalidate once to reconcile
  // the server-derived fields (title, unread, authoritative updatedAt). If
  // that refetch races the server's finalize and briefly resurrects
  // `generating: true`, the fast generating refetch (use-sessions.ts) is
  // re-armed by that very value and corrects it within seconds. External-store
  // sync in an effect (no setState) — same pattern as the mark-read effect.
  const generating = chat.status === "submitted" || chat.status === "streaming";
  const wasGenerating = useRef(false);
  useEffect(() => {
    if (generating) {
      const scope = getScope();
      queryClient.setQueryData<SessionsCache>(sessionsQueryKey(filterSpaceId), (prev) =>
        startTurnRow(prev, {
          id,
          created: isPersisted ? null : scope,
          now: new Date().toISOString(),
        }),
      );
    } else if (wasGenerating.current) {
      queryClient.setQueryData<SessionsCache>(sessionsQueryKey(filterSpaceId), (prev) =>
        patchSessionsCache(prev, (rows) =>
          rows.map((s) => (s.id === id ? { ...s, generating: false } : s)),
        ),
      );
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    }
    wasGenerating.current = generating;
  }, [generating, id, isPersisted, filterSpaceId, getScope, queryClient]);

  // On the first message of a brand-new conversation, lazily adopt its id into
  // the URL (the server creates the session on that same POST). `id` is stable
  // across this navigation (ChatPage's `??` keeps it once the URL holds it), so
  // the runtime key never flips under the in-flight send. Seeded `true` for an
  // already-persisted conversation so opening one never re-navigates. The
  // sidebar row itself is handled by the status-mirror effect above.
  const announced = useRef(isPersisted);
  useEffect(() => {
    if (announced.current || chat.messages.length === 0) return;
    announced.current = true;
    onConversationChange?.(id);
  }, [chat.messages.length, id, onConversationChange]);

  // assistant-ui's cancel action only aborts the browser fetch. Chat producers
  // intentionally survive disconnects so reload can resume them, therefore a
  // real user stop must also hit the dedicated server endpoint. Start that
  // independent request before aborting the local stream so it cannot be
  // mistaken for an ordinary disconnect.
  //
  // Every stop path (button, Escape) lands here, so this is also where the
  // message queue learns the user stopped: its messages are then held, not sent.
  const [messageQueue] = useState(createMessageQueue);
  const stop = useCallback(() => {
    messageQueue.markStopped();
    if (transport) void stopSession(transport, id).catch(() => {});
    return chat.stop();
  }, [chat, transport, id, messageQueue]);
  // The agent a message names joins it as it is sent; its skills stay in the text, which the
  // turn reads them from.
  const { sendMessage } = chat;
  const send = useCallback<typeof sendMessage>(
    (message, options) => sendMessage(sendWithDirectives(message), options),
    [sendMessage],
  );
  const chatWithServerStop = useMemo(
    () => ({ ...chat, stop, sendMessage: send }),
    [chat, stop, send],
  );

  const runtime = useAISDKRuntime(chatWithServerStop, { adapters: { attachments } });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        composerTools={composerTools}
        initialComposerDraft={initialComposerDraft}
        messageQueue={messageQueue}
      />
    </AssistantRuntimeProvider>
  );
}
