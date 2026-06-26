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
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelLeftIcon } from "lucide-react";
import { Thread } from "./thread.tsx";
import { ChatHeadersProvider, SelectConversationProvider } from "./runtime-context.ts";
import type { GetHeaders, SelectConversation } from "./runtime-context.ts";
import { ThreadList, ActiveConversationTitle } from "./thread-list.tsx";
import { ModelSelect } from "./model-select.tsx";
import { fetchModels, type OrgModelOption } from "./models-data.ts";
import { loadHistory, mintSessionId, SESSIONS_QUERY_KEY } from "./sessions.ts";
import { useSessions } from "./use-sessions.ts";
import { subscribeSeen, getSeen, markSeen, isUnread } from "./unread-store.ts";

const MODEL_STORAGE_KEY = "appstrate.chat.model";

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
   * Called when the active conversation changes (selection, new thread, or when
   * a brand-new conversation is created lazily on its first message). The host
   * navigates its URL.
   */
  onConversationChange?: SelectConversation;
}

export function ChatPage({
  getHeaders,
  conversationId,
  newChatKey,
  onConversationChange,
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

  const [mobileOpen, setMobileOpen] = useState(false);

  const [models, setModels] = useState<OrgModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(MODEL_STORAGE_KEY),
  );

  useEffect(() => {
    void fetchModels(getHeaders).then((list) => {
      setModels(list);
      setSelectedModel((cur) => {
        if (cur && list.some((m) => m.id === cur)) return cur;
        return (list.find((m) => m.is_default) ?? list[0])?.id ?? null;
      });
    });
  }, [getHeaders]);

  const selectModel = (id: string) => {
    setSelectedModel(id);
    localStorage.setItem(MODEL_STORAGE_KEY, id);
  };

  // Unread replies for conversations the user left mid-generation. The list
  // query polls (fast while generating); the seen watermark is an external store
  // so the unread pill stays reactive without React state (no setState-in-effect,
  // no render loop). There is no toast — the pill is the only notification.
  const sessions = useSessions();
  const seen = useSyncExternalStore(subscribeSeen, getSeen, getSeen);

  // Keep the OPEN conversation marked read up to its latest activity, so a reply
  // that lands while the user is watching it never counts as unread.
  useEffect(() => {
    const active = sessions.data?.find((s) => s.id === activeId);
    if (active) markSeen(active.id, active.updatedAt);
  }, [sessions.data, activeId]);

  const unreadIds = useMemo(() => {
    const list = sessions.data ?? [];
    return new Set(
      list.filter((s) => s.id !== activeId && isUnread(seen, s.id, s.updatedAt)).map((s) => s.id),
    );
  }, [sessions.data, activeId, seen]);

  return (
    <ChatHeadersProvider value={getHeaders ?? null}>
      <SelectConversationProvider value={onConversationChange ?? null}>
        <div className="bg-background flex h-full w-full">
          <aside className="hidden w-64 shrink-0 flex-col border-r md:flex">
            <ThreadList activeId={conversationId ?? null} unreadIds={unreadIds} />
          </aside>

          {mobileOpen && (
            <div className="fixed inset-0 z-40 md:hidden">
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setMobileOpen(false)}
                aria-hidden
              />
              <aside
                className="bg-background absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r shadow-xl"
                onClickCapture={(e) => {
                  if ((e.target as HTMLElement).closest("button")) setMobileOpen(false);
                }}
              >
                <ThreadList activeId={conversationId ?? null} unreadIds={unreadIds} />
              </aside>
            </div>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-label="Conversations"
                className="hover:bg-accent -ml-1 rounded-md p-1.5 md:hidden"
              >
                <PanelLeftIcon className="size-5" />
              </button>
              <div className="min-w-0 flex-1">
                <ActiveConversationTitle activeId={conversationId ?? null} />
              </div>
            </div>
            <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <Conversation
                key={activeId}
                id={activeId}
                getHeaders={getHeaders}
                selectedModel={selectedModel}
                isPersisted={isPersisted}
                onConversationChange={onConversationChange}
                composerSlot={
                  <ModelSelect models={models} selectedId={selectedModel} onSelect={selectModel} />
                }
              />
            </main>
          </div>
        </div>
      </SelectConversationProvider>
    </ChatHeadersProvider>
  );
}

interface ConversationProps {
  id: string;
  getHeaders?: GetHeaders;
  selectedModel: string | null;
  isPersisted: boolean;
  onConversationChange?: SelectConversation;
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
  selectedModel,
  isPersisted,
  onConversationChange,
  composerSlot,
}: ConversationProps & { initialMessages: UIMessage[] }) {
  const queryClient = useQueryClient();

  // Header builder invoked by the transport at request/reconnect time. Depends on
  // the model state (no ref), so the transport rebuilds when the model changes —
  // useChat picks it up for the next send. `getHeaders` is a stable host fn.
  const buildHeaders = useCallback(
    (): Record<string, string> => ({
      ...getHeaders?.(),
      ...(selectedModel ? { "X-Model-Id": selectedModel } : {}),
    }),
    [getHeaders, selectedModel],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        credentials: "include",
        headers: buildHeaders,
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
    onFinish: () => {
      // Surface the (possibly new) conversation + its derived title in the list.
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  // On the first message of a brand-new conversation, lazily adopt its id into
  // the URL (the server creates the session on that same POST) and surface it in
  // the sidebar. `id` is stable across this navigation (ChatPage's `??` keeps it
  // once the URL holds it), so the runtime key never flips under the in-flight
  // send. Seeded `true` for an already-persisted conversation so opening one
  // neither re-navigates nor refetches.
  const announced = useRef(isPersisted);
  useEffect(() => {
    if (announced.current) return;
    if (chat.messages.length > 0) {
      announced.current = true;
      onConversationChange?.(id);
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    }
  }, [chat.messages.length, id, onConversationChange, queryClient]);

  const runtime = useAISDKRuntime(chat);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread composerSlot={composerSlot} />
    </AssistantRuntimeProvider>
  );
}
