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
 *    `GET /api/chat/sessions/:id/stream`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AssistantRuntimeProvider, type AttachmentAdapter } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Thread } from "./thread.tsx";
import {
  ChatHeadersProvider,
  ChatHostProvider,
  SelectConversationProvider,
} from "./runtime-context.ts";
import type {
  ChatHost,
  ChatTranslate,
  DownloadDocument,
  GetHeaders,
  OpenDocument,
  SelectConversation,
  UploadFile,
  UseDocumentImageSrc,
} from "./runtime-context.ts";
export type {
  ChatTranslate,
  GetHeaders,
  OpenDocument,
  SelectConversation,
} from "./runtime-context.ts";
export { ChatConversationList, ChatConversationTitle } from "./thread-list.tsx";
export { ChatHeadersProvider, SelectConversationProvider } from "./runtime-context.ts";
import { ModelSelect } from "./model-select.tsx";
import { fetchModels, type OrgModelOption } from "./models-data.ts";
import { isModelLive } from "../model-liveness.ts";
import {
  loadHistory,
  markSessionRead,
  mintSessionId,
  SESSIONS_QUERY_KEY,
  stopSession,
  type SessionSummary,
} from "./sessions.ts";
import { useSessions } from "./use-sessions.ts";
import {
  subscribeGeneration,
  subscribeModel,
  getCompatibleGenerationSettings,
  getGenerationSettings,
  getSelectedModel,
  setGenerationSettings,
  setModelGenerationCapabilities,
  setSelectedModel,
} from "./model-store.ts";
import { createChatAttachmentAdapter } from "./attachment-adapter.ts";

// Tab visibility as an external store — the mark-read effect must not fire
// while the tab is hidden: SSE-driven invalidations refetch the list even in
// background tabs, and marking a conversation read the user is not looking at
// would silently clear the unread badge on every device.
const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const getVisible = () => document.visibilityState === "visible";

export interface ChatPageProps {
  getHeaders?: GetHeaders;
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
   * Presents a clicked chat document or a live run's primary output through the
   * host's in-app viewer. Optional: without it direct clicks fall back to
   * `downloadDocument` and automatic presentation is skipped. Delivered to deep
   * tool UIs via context, not props.
   */
  onOpenDocument?: OpenDocument;
  /**
   * REQUIRED host services — the chat implements none of them itself (see
   * `runtime-context.ts`): the authenticated download, the authenticated image
   * preview hook, the staged uploader, and the translator for user-facing text.
   */
  downloadDocument: DownloadDocument;
  useDocumentImageSrc: UseDocumentImageSrc;
  uploadFile: UploadFile;
  t: ChatTranslate;
}

export function ChatPage({
  getHeaders,
  conversationId,
  newChatKey,
  initialComposerDraft,
  onConversationChange,
  onOpenDocument,
  downloadDocument,
  useDocumentImageSrc,
  uploadFile,
  t,
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

  const [models, setModels] = useState<OrgModelOption[]>([]);
  // Model selection lives in an external store (localStorage-backed), not React
  // state: the transport's header builder reads it per request through a stable
  // function (see ConversationInner), so a switch applies to the very next send
  // without remounting the conversation. This hook only mirrors it for the picker.
  const selectedModel = useSyncExternalStore(subscribeModel, getSelectedModel, getSelectedModel);
  const generation = useSyncExternalStore(
    subscribeGeneration,
    getGenerationSettings,
    getGenerationSettings,
  );

  useEffect(() => {
    void fetchModels(getHeaders).then((list) => {
      setModels(list);
      setModelGenerationCapabilities(list);
      // Reconcile a stale/absent stored selection to the org default. A model
      // whose credential went dead is listed (the picker marks it, unpickable)
      // but must not be kept as the stored selection nor adopted as the
      // fallback — the server would reject it on the next send.
      const live = list.filter(isModelLive);
      const cur = getSelectedModel();
      if (cur && live.some((m) => m.id === cur)) return;
      setSelectedModel((live.find((m) => m.is_default) ?? live[0])?.id ?? null);
    });
  }, [getHeaders]);

  // Unread replies for conversations the user left mid-generation. `unread` is
  // server-computed (read-state lives in `chat_sessions`, shared across
  // devices); the list stays fresh via the `chat_session_update` SSE signal.
  // There is no toast — the pill is the only notification.
  const sessions = useSessions();
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
  useEffect(() => {
    if (!visible) return;
    const active = sessions.data?.find((s) => s.id === activeId);
    if (!active?.unread) return;
    queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (prev) =>
      prev?.map((s) => (s.id === activeId ? { ...s, unread: false } : s)),
    );
    void markSessionRead(getHeaders, activeId).catch(() => {});
  }, [sessions.data, activeId, getHeaders, queryClient, visible]);

  // The host services, published as ONE value (see `runtime-context.ts`). Every
  // member is a stable host function, so this object is referentially stable
  // between renders and consumers re-render no more than with a context each.
  const host = useMemo<ChatHost>(
    () => ({
      openDocument: onOpenDocument ?? null,
      downloadDocument,
      useDocumentImageSrc,
      t,
    }),
    [onOpenDocument, downloadDocument, useDocumentImageSrc, t],
  );

  // File attachments: the composer stages picked files through the HOST uploader
  // and sends them as `upload://` file parts the server materializes into
  // durable documents. Built HERE (where the host props land) and handed down as
  // a single prop — its only consumer is the runtime mounted two components
  // below, in this same file, so it needs no context hop.
  const attachments = useMemo(
    () => createChatAttachmentAdapter({ upload: uploadFile, t }),
    [uploadFile, t],
  );

  return (
    <ChatHeadersProvider value={getHeaders ?? null}>
      <SelectConversationProvider value={onConversationChange ?? null}>
        <ChatHostProvider value={host}>
          {/* The conversation list and the conversation title are NOT here:
              they are the shell's navigation and the shell's "where you are",
              mounted by the host from `ChatConversationList` /
              `ChatConversationTitle`. What is left is the thread itself. */}
          {/* A plain div, not a `main`: the host shell's inset already IS the
              page's `main` landmark, and two nested ones name two pages. */}
          <div className="bg-canvas flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
            <Conversation
              key={activeId}
              id={activeId}
              getHeaders={getHeaders}
              isPersisted={isPersisted}
              initialComposerDraft={isPersisted ? undefined : initialComposerDraft}
              onConversationChange={onConversationChange}
              attachments={attachments}
              composerSlot={
                <div className="flex items-center gap-2">
                  <ModelSelect
                    models={models}
                    selectedId={selectedModel}
                    onSelect={setSelectedModel}
                    generation={generation}
                    onGenerationChange={setGenerationSettings}
                  />
                </div>
              }
            />
          </div>
        </ChatHostProvider>
      </SelectConversationProvider>
    </ChatHeadersProvider>
  );
}

interface ConversationProps {
  id: string;
  getHeaders?: GetHeaders;
  isPersisted: boolean;
  initialComposerDraft?: string;
  onConversationChange?: SelectConversation;
  /** Composer attachment adapter, built once by `ChatPage` from the host props. */
  attachments: AttachmentAdapter;
  composerSlot?: React.ReactNode;
}

/**
 * Loads a conversation's history, then mounts the runtime once seeded. Gating on
 * the history load keeps `useChat`'s initial `messages` correct (the option is
 * read once at mount, not reactive). A not-yet-persisted conversation is
 * known-empty, so we skip the GET entirely (`enabled: false`) and seed `[]`
 * immediately — no speculative 404, no composer flash.
 */
function Conversation({ id, getHeaders, isPersisted, ...rest }: ConversationProps) {
  // Freeze persistence at mount. The runtime key (`id`) is stable across the
  // lazy URL adoption, so this component does NOT remount when `isPersisted`
  // flips false→true on the first send. If we read the live prop, that flip
  // would enable+fire the history query, whose pending state would trip the
  // loading gate below and UNMOUNT the in-flight runtime — destroying the
  // streaming turn. A conversation that started new stays "load-free" for its
  // whole life; only a deep-linked (persisted-at-mount) one loads history.
  const [persistedAtMount] = useState(isPersisted);
  const history = useQuery({
    queryKey: ["chat", "session", id],
    queryFn: () => loadHistory(getHeaders, id),
    enabled: persistedAtMount,
    staleTime: Infinity,
    gcTime: 0,
  });

  if (persistedAtMount && history.isPending) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Chargement…
      </div>
    );
  }
  return (
    <ConversationInner
      id={id}
      getHeaders={getHeaders}
      isPersisted={persistedAtMount}
      initialMessages={history.data ?? []}
      {...rest}
    />
  );
}

function ConversationInner({
  id,
  getHeaders,
  initialMessages,
  isPersisted,
  onConversationChange,
  attachments,
  composerSlot,
  initialComposerDraft,
}: ConversationProps & { initialMessages: UIMessage[] }) {
  const queryClient = useQueryClient();

  // Header builder invoked by the transport at request/reconnect time. It reads
  // the model from the external store, NOT from React state: `useChat` recreates
  // its `Chat` instance only when `id` changes, so a transport rebuilt over
  // fresh state would be silently ignored and every send would keep the model
  // captured at mount. The store read resolves per request, so a model switch
  // applies to the next send. `getHeaders` is a stable host fn.
  const buildHeaders = useCallback((): Record<string, string> => {
    const model = getSelectedModel();
    return {
      ...getHeaders?.(),
      ...(model ? { "X-Model-Id": model } : {}),
    };
  }, [getHeaders]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        credentials: "include",
        headers: buildHeaders,
        prepareSendMessagesRequest: ({ id: chatId, messages, body }) => ({
          body: {
            ...body,
            id: chatId,
            messages,
            generation: getCompatibleGenerationSettings(),
          },
        }),
        // Native resume targets our per-session stream endpoint (the chat id is
        // the conversation id = the URL).
        prepareReconnectToStreamRequest: ({ id: chatId }) => ({
          api: `/api/chat/sessions/${chatId}/stream`,
        }),
      }),
    [buildHeaders],
  );

  const chat = useChat({
    id,
    messages: initialMessages,
    transport,
    // Reconnect to an in-flight turn on mount (mid-inference reload). 204 when
    // nothing is generating (the common case) → no-op.
    resume: true,
  });

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
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (prev) => {
        const list = prev ?? [];
        const existing = list.find((s) => s.id === id);
        const row: SessionSummary = {
          ...(existing ?? { id, title: null, unread: false }),
          generating: true,
          updatedAt: new Date().toISOString(),
        };
        return [row, ...list.filter((s) => s.id !== id)];
      });
    } else if (wasGenerating.current) {
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (prev) =>
        prev?.map((s) => (s.id === id ? { ...s, generating: false } : s)),
      );
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    }
    wasGenerating.current = generating;
  }, [generating, id, queryClient]);

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
  const stop = useCallback(() => {
    void stopSession(getHeaders, id).catch(() => {});
    return chat.stop();
  }, [chat, getHeaders, id]);
  const chatWithServerStop = useMemo(() => ({ ...chat, stop }), [chat, stop]);

  const runtime = useAISDKRuntime(chatWithServerStop, { adapters: { attachments } });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread composerSlot={composerSlot} initialComposerDraft={initialComposerDraft} />
    </AssistantRuntimeProvider>
  );
}
