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
import { AssistantRuntimeProvider, useRemoteThreadListRuntime } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { PanelLeftIcon, InfoIcon } from "lucide-react";
import { Thread } from "./thread.tsx";
import { ThreadList, ActiveConversationTitle } from "./thread-list.tsx";
import { makeThreadListAdapter } from "./thread-list-adapter.tsx";
import { ModelSelect } from "./model-select.tsx";
import { fetchModels, type OrgModelOption } from "./models-data.ts";

const MODEL_STORAGE_KEY = "appstrate.chat.model";

export interface ChatPageProps {
  getHeaders?: () => Record<string, string>;
  /**
   * Whether platform tools (run agents, inspect runs, search…) are available —
   * i.e. the `mcp` module is active. When `false`, the chat still works for
   * plain conversation (the backend degrades gracefully) and a banner explains
   * that tools are off. Left `undefined` by embedders that don't gate on it.
   */
  toolsAvailable?: boolean;
}

/**
 * Full-page chat — what the app shell lazy-loads on `/chat`. Runs
 * assistant-ui's native remote thread-list runtime: conversation list on
 * the left (create/rename/delete), per-thread history restored from
 * `chat_sessions`/`chat_messages` through the history adapter.
 */
export function ChatPage({ getHeaders, toolsAvailable }: ChatPageProps) {
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
    <AssistantRuntimeProvider runtime={runtime}>
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
          {toolsAvailable === false && (
            <div
              role="status"
              className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400"
            >
              <InfoIcon className="size-3.5 shrink-0" />
              <span>
                Aucun outil disponible — le module <code>mcp</code> n'est pas actif. Le chat répond
                en conversation simple (pas d'agents, runs ni recherche).
              </span>
            </div>
          )}
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <Thread
              composerSlot={
                <ModelSelect models={models} selectedId={selectedModel} onSelect={selectModel} />
              }
            />
          </main>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
