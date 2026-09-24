// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, ReactNode } from "react";
import {
  ActivityIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileIcon,
  FilesIcon,
  InfoIcon,
  Maximize2Icon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { $api } from "../../api/client";
import { Badge } from "../../components/status-badge";
import { FilePreview } from "../../components/file-preview";
import { FileViewer } from "../../components/file-viewer";
import { useFile, useFileDownload, useFiles } from "../../hooks/use-files";
import { useOrgOnlyScope, useOrgScope } from "../../hooks/use-org-scope";
import { formatDateField } from "../../lib/format-date";
import type {
  ConversationSidebarAction,
  ConversationSidebarState,
  ConversationSidebarTab,
  SidebarFile,
} from "./conversation-sidebar-state";

const CONVERSATION_CONTEXT_PANEL_ID = "conversation-context-panel";

function useConversationTabs() {
  const { t } = useTranslation("chat");
  return [
    { id: "preview", Icon: EyeIcon, label: t("context.tabs.preview") },
    { id: "runs", Icon: ActivityIcon, label: t("context.tabs.runs") },
    { id: "files", Icon: FilesIcon, label: t("context.tabs.files") },
    { id: "info", Icon: InfoIcon, label: t("context.tabs.info") },
  ] as const satisfies readonly {
    id: ConversationSidebarTab;
    Icon: typeof EyeIcon;
    label: string;
  }[];
}

export function ConversationContextActions({
  state,
  dispatch,
}: {
  state: ConversationSidebarState;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const tabs = useConversationTabs();

  return (
    <TooltipProvider delayDuration={300}>
      <Tabs
        value={state.expanded ? state.activeTab : ""}
        onValueChange={(tab) =>
          dispatch({ type: "select-tab", tab: tab as ConversationSidebarTab })
        }
      >
        <TabsList className="h-8" aria-label={t("context.label")}>
          {tabs.map(({ id, Icon, label }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <TabsTrigger
                  id={`conversation-context-${id}-tab`}
                  value={id}
                  className="aria-selected:bg-background aria-selected:text-foreground size-7 p-0 aria-selected:shadow"
                  aria-label={label}
                  aria-controls={CONVERSATION_CONTEXT_PANEL_ID}
                >
                  <Icon className="size-4" />
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{label}</TooltipContent>
            </Tooltip>
          ))}
        </TabsList>
      </Tabs>
    </TooltipProvider>
  );
}

function PanelState({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
      {children}
    </div>
  );
}

function PreviewTab({ file, onOpenModal }: { file: SidebarFile | null; onOpenModal: () => void }) {
  const { t } = useTranslation(["chat", "files"]);
  const download = useFileDownload();
  const { data, isLoading, error } = useFile(file?.id ?? "");

  if (!file) return <PanelState>{t("context.preview.empty", { ns: "chat" })}</PanelState>;

  const name = file.name || data?.name || t("context.file.untitled", { ns: "chat" });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
          {name}
        </span>
        {data?.downloadable ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("row.download", { ns: "files" })}
            onClick={() => void download(file.id, name)}
          >
            <DownloadIcon className="size-4" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("context.preview.openModal", { ns: "chat" })}
          onClick={onOpenModal}
        >
          <Maximize2Icon className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 p-3">
        <FileViewer fileId={file.id} file={data} isLoading={isLoading} error={error} />
      </div>
    </div>
  );
}

function ConversationRuns({
  conversationId,
  active,
}: {
  conversationId: string | null;
  active: boolean;
}) {
  const { t } = useTranslation("chat");
  const scope = useOrgScope();
  const query = $api.useQuery(
    "get",
    "/api/runs",
    {
      params: {
        query: { chat_session_id: conversationId ?? undefined, limit: 100 },
        header: scope.header,
      },
    },
    { enabled: scope.enabled && active && !!conversationId },
  );

  if (!conversationId) return <PanelState>{t("context.unsaved")}</PanelState>;
  if (query.isLoading) return <PanelState>{t("context.loading")}</PanelState>;
  if (query.error) return <PanelState>{t("context.error")}</PanelState>;
  const runs = query.data?.data ?? [];
  if (runs.length === 0) return <PanelState>{t("context.runs.empty")}</PanelState>;

  return (
    <div className="divide-y">
      {runs.map((run) => {
        const label = run.agent_name || run.packageId || t("run.fallbackLabel");
        const content = (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <ActivityIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
              <Badge status={run.status} compact />
              {run.packageId ? (
                <ExternalLinkIcon className="text-muted-foreground size-3.5" />
              ) : null}
            </div>
            <div className="text-muted-foreground mt-1 flex items-center justify-between gap-2 pl-6 text-xs">
              <span className="truncate font-mono">{run.id}</span>
              <span className="shrink-0">{formatDateField(run.started_at)}</span>
            </div>
          </>
        );
        return run.packageId ? (
          <Link
            key={run.id}
            className="hover:bg-muted/50 block px-3 py-3"
            to={`/agents/${run.packageId}/runs/${run.id}`}
          >
            {content}
          </Link>
        ) : (
          <div key={run.id} className="px-3 py-3">
            {content}
          </div>
        );
      })}
    </div>
  );
}

function ConversationFiles({
  conversationId,
  active,
  onSelect,
}: {
  conversationId: string | null;
  active: boolean;
  onSelect: (file: SidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  const query = useFiles({
    contextChatSessionId: conversationId ?? undefined,
    limit: 100,
    enabled: active && !!conversationId,
  });

  if (!conversationId) return <PanelState>{t("context.unsaved")}</PanelState>;
  if (query.isLoading) return <PanelState>{t("context.loading")}</PanelState>;
  if (query.error) return <PanelState>{t("context.error")}</PanelState>;
  const files = query.data?.data ?? [];
  if (files.length === 0) return <PanelState>{t("context.files.empty")}</PanelState>;

  return (
    <div className="divide-y">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-3 text-left"
          onClick={() => onSelect({ id: file.id, name: file.name })}
        >
          <FileIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{file.name}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {file.purpose === "user_upload"
                ? t("context.files.attachment")
                : t("context.files.output")}
            </span>
          </span>
          <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
        </button>
      ))}
    </div>
  );
}

function ConversationInfo({
  conversationId,
  active,
}: {
  conversationId: string | null;
  active: boolean;
}) {
  const { t } = useTranslation("chat");
  const scope = useOrgOnlyScope();
  const query = $api.useQuery(
    "get",
    "/api/chat/sessions/{id}",
    {
      params: {
        path: { id: conversationId ?? "" },
        header: scope.header,
      },
    },
    { enabled: scope.enabled && active && !!conversationId },
  );

  if (!conversationId) return <PanelState>{t("context.unsaved")}</PanelState>;
  if (query.isLoading) return <PanelState>{t("context.loading")}</PanelState>;
  if (query.error || !query.data) return <PanelState>{t("context.error")}</PanelState>;

  const session = query.data;
  const rows = [
    [t("context.info.title"), session.title || t("context.info.untitled")],
    [t("context.info.id"), session.id],
    [t("context.info.created"), formatDateField(session.createdAt)],
    [t("context.info.updated"), formatDateField(session.updatedAt)],
    [t("context.info.messages"), String(session.messages.length)],
    [
      t("context.info.status"),
      session.generating ? t("context.info.generating") : t("context.info.idle"),
    ],
  ];

  return (
    <dl className="divide-y">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 px-3 py-3 text-sm">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ConversationSidebar({
  conversationId,
  state,
  dispatch,
}: {
  conversationId: string | null;
  state: ConversationSidebarState;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const tabs = useConversationTabs();
  const activeTab = tabs.find(({ id }) => id === state.activeTab) ?? tabs[0];
  const ActiveTabIcon = activeTab.Icon;
  const showFile = (file: SidebarFile) => dispatch({ type: "show-file", file });

  return (
    <>
      {state.expanded ? (
        <button
          type="button"
          className="absolute inset-0 z-20 bg-black/30 lg:hidden"
          aria-label={t("context.collapse")}
          onClick={() => dispatch({ type: "toggle" })}
        />
      ) : null}
      {state.expanded ? (
        <aside
          id={CONVERSATION_CONTEXT_PANEL_ID}
          role="tabpanel"
          aria-labelledby={`conversation-context-${state.activeTab}-tab`}
          aria-label={t("context.label")}
          className="bg-background absolute inset-y-0 right-0 z-30 flex h-full w-[min(92vw,36rem)] shrink-0 flex-col border-l shadow-xl lg:static lg:w-[42vw] lg:max-w-[42rem] lg:min-w-[28rem] lg:shadow-none"
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-sm font-medium">
              <ActiveTabIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate">{activeTab.label}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("context.collapse")}
              onClick={() => dispatch({ type: "toggle" })}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {state.activeTab === "preview" ? (
              <PreviewTab
                file={state.selectedFile}
                onOpenModal={() => dispatch({ type: "open-modal" })}
              />
            ) : null}
            {state.activeTab === "runs" ? (
              <ConversationRuns conversationId={conversationId} active />
            ) : null}
            {state.activeTab === "files" ? (
              <ConversationFiles conversationId={conversationId} active onSelect={showFile} />
            ) : null}
            {state.activeTab === "info" ? (
              <ConversationInfo conversationId={conversationId} active />
            ) : null}
          </div>
        </aside>
      ) : null}
      {state.modalFile ? (
        <FilePreview file={state.modalFile} onClose={() => dispatch({ type: "close-modal" })} />
      ) : null}
    </>
  );
}
