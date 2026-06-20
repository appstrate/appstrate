// SPDX-License-Identifier: Apache-2.0

/**
 * Chat module UI — exported from `@appstrate/module-chat/ui`.
 *
 * Component-first design: `ChatPanel` is the embeddable unit (the documents/
 * workspace module mounts it in a side panel and injects a `context`);
 * `ChatPage` is the thin full-page wrapper the app shell lazy-loads behind
 * `features.chat`.
 *
 * The conversation runs on assistant-ui's native AI SDK runtime
 * (`useChatRuntime` + `AssistantChatTransport` → `POST /api/chat`,
 * UIMessage streaming). `ChatPage` adds the native remote thread-list
 * (persisted sessions); the embedded `ChatPanel` is single-thread and
 * ephemeral by design.
 *
 * Embeddability discipline (keep it that way):
 *   - no global store: every instance owns its runtime (multiple panels OK)
 *   - no internal navigation: the host decides where the panel lives
 *   - theme via inherited Tailwind tokens only
 *   - API access via fetch + injected headers (the host shell passes its
 *     org/app headers through `getHeaders`)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, useRemoteThreadListRuntime } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { PanelLeftIcon, PanelRightIcon, InfoIcon } from "lucide-react";
import { Thread } from "./thread.tsx";
import { ThreadList, ActiveConversationTitle } from "./thread-list.tsx";
import { makeThreadListAdapter } from "./thread-list-adapter.tsx";
import { ModelSelect, fetchModels, type OrgModelOption } from "./model-select.tsx";
import { ArtifactPanelContext, ArtifactPanel, type Artifact } from "./artifact-panel.tsx";
import { AgentRunPanel, useThreadRuns } from "./agent-run-panel.tsx";

export interface ChatContext {
  /** What the conversation is anchored to (e.g. "document", "run"). */
  type: string;
  id: string;
  label?: string;
}

export interface ChatPanelProps {
  /** Optional anchor injected by the host (e.g. the open file in the workspace). */
  context?: ChatContext;
  /** Org/app scoping headers supplied by the host shell (X-Org-Id, …). */
  getHeaders?: () => Record<string, string>;
  /** Pin a model (preset id) — hides the picker. Default: user-picked, then org default. */
  modelId?: string;
  className?: string;
}

const MODEL_STORAGE_KEY = "appstrate.chat.model";

export function ChatPanel({ context, getHeaders, modelId, className }: ChatPanelProps) {
  const contextRef = useRef(context);
  contextRef.current = context;

  // Model picker (hidden when the host pins `modelId`). The selection rides
  // in a ref so switching models never rebuilds the transport mid-thread.
  const [models, setModels] = useState<OrgModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(MODEL_STORAGE_KEY),
  );
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = modelId ?? selectedModel;

  useEffect(() => {
    if (modelId) return;
    void fetchModels(getHeaders).then((list) => {
      setModels(list);
      setSelectedModel((cur) => {
        if (cur && list.some((m) => m.id === cur)) return cur;
        return (list.find((m) => m.isDefault) ?? list[0])?.id ?? null;
      });
    });
  }, [getHeaders, modelId]);

  const selectModel = (id: string) => {
    setSelectedModel(id);
    localStorage.setItem(MODEL_STORAGE_KEY, id);
  };

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        credentials: "include",
        headers: (): Record<string, string> => ({
          ...getHeaders?.(),
          ...(selectedModelRef.current ? { "X-Model-Id": selectedModelRef.current } : {}),
        }),
        // Inject the host context into the JSON body — done in a fetch
        // wrapper so we stay on the transport's native request shape.
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          let body = init?.body;
          if (typeof body === "string") {
            try {
              body = JSON.stringify({
                ...(JSON.parse(body) as Record<string, unknown>),
                context: contextRef.current,
              });
            } catch {
              // Not JSON — forward untouched.
            }
          }
          return fetch(input, { ...init, body });
        }) as typeof fetch,
      }),
    [getHeaders],
  );

  const runtime = useChatRuntime({ transport });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={`flex h-full min-h-0 flex-col ${className ?? ""}`}>
        {context && (
          <div className="text-muted-foreground border-b px-3 py-2 text-xs">
            Contexte : {context.label ?? `${context.type} ${context.id}`}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Thread
            composerSlot={
              modelId ? undefined : (
                <ModelSelect models={models} selectedId={selectedModel} onSelect={selectModel} />
              )
            }
          />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

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
 * `chat_sessions`/`chat_messages` through the history adapter. The
 * embeddable `ChatPanel` stays single-thread (ephemeral) by design.
 */
export function ChatPage({ getHeaders, toolsAvailable }: ChatPageProps) {
  const adapter = useMemo(() => makeThreadListAdapter(getHeaders), [getHeaders]);

  // Thread-list column is a fixed sidebar on desktop; on mobile it collapses
  // into a left drawer toggled from the card header.
  const [mobileOpen, setMobileOpen] = useState(false);

  // Right rail: closed by default — opens on the header toggle, when an agent
  // run goes active (see AutoOpenAgentPanel), or when an artifact opens.
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const openPanel = useCallback(() => setPanelCollapsed(false), []);
  const openArtifact = (a: Artifact) => {
    setArtifact(a);
    setPanelCollapsed(false);
  };

  const [models, setModels] = useState<OrgModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(MODEL_STORAGE_KEY),
  );
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  useEffect(() => {
    void fetchModels(getHeaders).then((list) => {
      setModels(list);
      setSelectedModel((cur) => {
        if (cur && list.some((m) => m.id === cur)) return cur;
        return (list.find((m) => m.isDefault) ?? list[0])?.id ?? null;
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
      const transport = useMemo(
        () =>
          new AssistantChatTransport({
            api: "/api/chat",
            credentials: "include",
            headers: (): Record<string, string> => ({
              ...getHeaders?.(),
              ...(selectedModelRef.current ? { "X-Model-Id": selectedModelRef.current } : {}),
            }),
          }),
        [getHeaders],
      );
      return useChatRuntime({ transport });
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ArtifactPanelContext.Provider value={openArtifact}>
        {/* Auto-opens the rail when the conversation launches an agent. */}
        <AutoOpenAgentPanel onActiveRun={openPanel} />
        {/* One continuous surface: sidebar · chat · rail share the same
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
              <button
                type="button"
                onClick={() => setPanelCollapsed((v) => !v)}
                aria-label={panelCollapsed ? "Ouvrir le panneau" : "Fermer le panneau"}
                title={panelCollapsed ? "Ouvrir le panneau" : "Fermer le panneau"}
                className="text-muted-foreground hover:text-foreground hover:bg-accent hidden rounded-md p-1.5 lg:inline-flex"
              >
                <PanelRightIcon className="size-5" />
              </button>
            </div>
            {toolsAvailable === false && (
              <div
                role="status"
                className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400"
              >
                <InfoIcon className="size-3.5 shrink-0" />
                <span>
                  Aucun outil disponible — le module <code>mcp</code> n'est pas actif. Le chat
                  répond en conversation simple (pas d'agents, runs ni recherche).
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

          {/* Right rail (desktop only): an explicitly-opened artifact wins;
              otherwise the launched agent's run panel. Hidden until opened. */}
          {!panelCollapsed &&
            (artifact ? (
              <div className="hidden w-[44%] max-w-[720px] min-w-[380px] shrink-0 border-l lg:flex">
                <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />
              </div>
            ) : (
              <AgentRunPanel
                getHeaders={getHeaders}
                railClass="hidden w-80 shrink-0 flex-col border-l lg:flex"
              />
            ))}
        </div>
      </ArtifactPanelContext.Provider>
    </AssistantRuntimeProvider>
  );
}

/**
 * Invisible watcher (always mounted under the runtime) that opens the right
 * rail when a run goes active — i.e. the user just launched an agent (a
 * non-terminal run appears). Fires once per transition, so a manual close
 * isn't fought; historical conversations (all-terminal runs) don't auto-open.
 */
function AutoOpenAgentPanel({ onActiveRun }: { onActiveRun: () => void }) {
  const active = useThreadRuns().some(
    (r) => !r.status || r.status === "running" || r.status === "pending",
  );
  useEffect(() => {
    if (active) onActiveRun();
  }, [active, onActiveRun]);
  return null;
}
