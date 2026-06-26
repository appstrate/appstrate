// SPDX-License-Identifier: Apache-2.0

/**
 * Chat module UI — exported from `@appstrate/module-chat/ui`.
 *
 * `ChatPage` is the full-page chat the app shell lazy-loads behind
 * `features.chat`. The conversation runs on assistant-ui's native AI SDK
 * runtime (`useChatRuntime` + `AssistantChatTransport` → `POST /api/chat`,
 * UIMessage streaming), with the native remote thread-list (persisted
 * sessions). API access is fetch + injected org/app headers (passed through
 * `getHeaders` by the host shell).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useAssistantRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { PanelLeftIcon } from "lucide-react";
import { Thread } from "./thread.tsx";
import { ChatHeadersProvider, SelectConversationProvider } from "./runtime-context.ts";
import { ThreadList, ActiveConversationTitle } from "./thread-list.tsx";
import { makeThreadListAdapter } from "./thread-list-adapter.tsx";
import { ModelSelect } from "./model-select.tsx";
import { fetchModels, type OrgModelOption } from "./models-data.ts";

const MODEL_STORAGE_KEY = "appstrate.chat.model";

export interface ChatPageProps {
  getHeaders?: () => Record<string, string>;
  /**
   * Active conversation id (session `chs_…`) read from the host's URL, or
   * `null`/`undefined` for the "new conversation" state. The host wires this to
   * a route param so a refresh restores the same conversation.
   */
  conversationId?: string | null;
  /**
   * Called when the active conversation changes (selection, new thread, or a
   * deep-link that 404s and falls back to `null`). The host navigates its URL
   * accordingly. Router-agnostic: module-chat never imports a router.
   */
  onConversationChange?: (id: string | null) => void;
}

/**
 * Drives assistant-ui's active thread from the host URL — the single source of
 * truth. Must render inside <AssistantRuntimeProvider>.
 *
 *  - URL → runtime (dominant flow): switch to the URL's conversation (after the
 *    thread list has loaded, so a refresh deep-link resolves), or to a fresh
 *    thread when the URL carries no id. An unknown/foreign id rejects → `/chat`.
 *  - runtime → URL (narrow): a brand-new conversation only gets its id server-
 *    side after the first message. When the active thread acquires a `remoteId`
 *    the URL doesn't have yet, push it. This never navigates to `null` — that is
 *    the asymmetry that keeps the URL stable (transient pre-switch `null`s and
 *    load states are ignored), so there is no URL↔runtime feedback loop.
 */
function ChatUrlSync({
  conversationId,
  onConversationChange,
}: Pick<ChatPageProps, "conversationId" | "onConversationChange">) {
  const runtime = useAssistantRuntime();
  const urlId = conversationId ?? null;
  const urlIdRef = useRef(urlId);
  useEffect(() => {
    urlIdRef.current = urlId;
  }, [urlId]);

  // URL → runtime
  useEffect(() => {
    if (runtime.threads.mainItem.getState().remoteId === urlId) return;
    if (!urlId) {
      void runtime.threads.switchToNewThread();
      return;
    }
    void runtime.threads
      .getLoadThreadsPromise()
      .then(() => runtime.threads.switchToThread(urlId))
      .catch(() => onConversationChange?.(null));
  }, [urlId, runtime, onConversationChange]);

  // runtime → URL (capture a newly created conversation's id only)
  useEffect(() => {
    return runtime.threads.subscribe(() => {
      const id = runtime.threads.mainItem.getState().remoteId;
      if (id && id !== urlIdRef.current) onConversationChange?.(id);
    });
  }, [runtime, onConversationChange]);

  return null;
}

/**
 * Full-page chat — what the app shell lazy-loads on `/chat`. Runs
 * assistant-ui's native remote thread-list runtime: conversation list on
 * the left (create/rename/delete), per-thread history restored from
 * `chat_sessions`/`chat_messages` through the history adapter.
 */
export function ChatPage({ getHeaders, conversationId, onConversationChange }: ChatPageProps) {
  const adapter = useMemo(() => makeThreadListAdapter(getHeaders), [getHeaders]);

  // Thread-list column is a fixed sidebar on desktop; on mobile it collapses
  // into a left drawer toggled from the card header.
  const [mobileOpen, setMobileOpen] = useState(false);

  const [models, setModels] = useState<OrgModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(MODEL_STORAGE_KEY),
  );
  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

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

  const runtime = useRemoteThreadListRuntime({
    adapter,
    runtimeHook: function PageChatRuntime() {
      // Ref read in a request-time callback (not render). Stable identity keeps
      // the transport memo from rebuilding on model change.
      const buildHeaders = useCallback(
        (): Record<string, string> => ({
          ...getHeaders?.(),
          ...(selectedModelRef.current ? { "X-Model-Id": selectedModelRef.current } : {}),
        }),
        // `getHeaders` is captured from the enclosing `ChatPage` closure — it is
        // not a reactive value of this nested runtime hook, and `selectedModelRef`
        // is a ref (exempt). Both are read via `?.()`/`.current` at request time,
        // so a stable empty-dep callback is correct (no stale closure).
        [],
      );
      const transport = useMemo(
        () =>
          new AssistantChatTransport({
            api: "/api/chat",
            credentials: "include",
            headers: buildHeaders,
          }),
        [buildHeaders],
      );
      return useChatRuntime({ transport });
    },
  });

  return (
    <ChatHeadersProvider value={getHeaders ?? null}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatUrlSync conversationId={conversationId} onConversationChange={onConversationChange} />
        <SelectConversationProvider value={onConversationChange ?? null}>
          {/* One continuous surface: sidebar · chat share the same
            background, separated by hairline borders (no floating cards). */}
          <div className="bg-background flex h-full w-full">
            <aside className="hidden w-64 shrink-0 flex-col border-r md:flex">
              <ThreadList />
            </aside>

            {/* Mobile: thread-list drawer (closes on backdrop click or selection) */}
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
                  <ThreadList />
                </aside>
              </div>
            )}

            {/* Chat column */}
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
                {/* Active conversation title + actions (rename/delete) */}
                <div className="min-w-0 flex-1">
                  <ActiveConversationTitle />
                </div>
              </div>
              <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <Thread
                  composerSlot={
                    <ModelSelect
                      models={models}
                      selectedId={selectedModel}
                      onSelect={selectModel}
                    />
                  }
                />
              </main>
            </div>
          </div>
        </SelectConversationProvider>
      </AssistantRuntimeProvider>
    </ChatHeadersProvider>
  );
}
