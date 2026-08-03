// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, ReactNode } from "react";
import {
  ActivityIcon,
  ChevronLeftIcon,
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
import { cn } from "@appstrate/ui/cn";
import { $api } from "../../api/client";
import { Badge } from "../../components/status-badge";
import { DocumentPreview } from "../../components/document-preview";
import { DocumentViewer } from "../../components/document-viewer";
import { useDocument, useDocumentDownload, useDocuments } from "../../hooks/use-documents";
import { useOrgOnlyScope, useOrgScope } from "../../hooks/use-org-scope";
import { formatDateField } from "../../lib/markdown";
import type {
  ConversationSidebarAction,
  ConversationSidebarState,
  ConversationSidebarTab,
  SidebarDocument,
} from "./conversation-sidebar-state";

const TAB_ICONS = {
  preview: EyeIcon,
  runs: ActivityIcon,
  documents: FilesIcon,
  info: InfoIcon,
} satisfies Record<ConversationSidebarTab, typeof EyeIcon>;

function PanelState({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
      {children}
    </div>
  );
}

function PreviewTab({
  document,
  onOpenModal,
}: {
  document: SidebarDocument | null;
  onOpenModal: () => void;
}) {
  const { t } = useTranslation(["chat", "documents"]);
  const download = useDocumentDownload();
  const { data, isLoading, error } = useDocument(document?.id ?? "");

  if (!document) return <PanelState>{t("context.preview.empty", { ns: "chat" })}</PanelState>;

  const name = document.name || data?.name || t("context.document.untitled", { ns: "chat" });
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
            aria-label={t("row.download", { ns: "documents" })}
            onClick={() => void download(document.id, name)}
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
        <DocumentViewer
          documentId={document.id}
          document={data}
          isLoading={isLoading}
          error={error}
        />
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

function ConversationDocuments({
  conversationId,
  active,
  onSelect,
}: {
  conversationId: string | null;
  active: boolean;
  onSelect: (document: SidebarDocument) => void;
}) {
  const { t } = useTranslation("chat");
  const query = useDocuments({
    contextChatSessionId: conversationId ?? undefined,
    limit: 100,
    enabled: active && !!conversationId,
  });

  if (!conversationId) return <PanelState>{t("context.unsaved")}</PanelState>;
  if (query.isLoading) return <PanelState>{t("context.loading")}</PanelState>;
  if (query.error) return <PanelState>{t("context.error")}</PanelState>;
  const documents = query.data?.data ?? [];
  if (documents.length === 0) return <PanelState>{t("context.documents.empty")}</PanelState>;

  return (
    <div className="divide-y">
      {documents.map((document) => (
        <button
          key={document.id}
          type="button"
          className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-3 text-left"
          onClick={() => onSelect({ id: document.id, name: document.name })}
        >
          <FileIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{document.name}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {document.purpose === "user_upload"
                ? t("context.documents.attachment")
                : t("context.documents.output")}
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
  const tabLabels = {
    preview: t("context.tabs.preview"),
    runs: t("context.tabs.runs"),
    documents: t("context.tabs.documents"),
    info: t("context.tabs.info"),
  } satisfies Record<ConversationSidebarTab, string>;
  const tabs = (Object.keys(TAB_ICONS) as ConversationSidebarTab[]).map((id) => ({
    id,
    Icon: TAB_ICONS[id],
    label: tabLabels[id],
  }));
  const showDocument = (document: SidebarDocument) => dispatch({ type: "show-document", document });

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
      <aside
        aria-label={t("context.label")}
        className={cn(
          "bg-background flex h-full shrink-0 border-l",
          state.expanded
            ? "absolute inset-y-0 right-0 z-30 w-[min(92vw,36rem)] flex-col shadow-xl lg:static lg:w-[42vw] lg:max-w-[42rem] lg:min-w-[28rem] lg:shadow-none"
            : "w-12 flex-col",
        )}
      >
        {state.expanded ? (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
              <Tabs
                value={state.activeTab}
                onValueChange={(tab) =>
                  dispatch({ type: "select-tab", tab: tab as ConversationSidebarTab })
                }
                className="min-w-0 flex-1"
              >
                <TabsList className="grid w-full grid-cols-4">
                  {tabs.map(({ id, Icon, label }) => (
                    <TabsTrigger key={id} value={id} className="gap-1.5 px-2" aria-label={label}>
                      <Icon className="size-3.5" />
                      <span className="hidden xl:inline">{label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
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
                  document={state.selectedDocument}
                  onOpenModal={() => dispatch({ type: "open-modal" })}
                />
              ) : null}
              {state.activeTab === "runs" ? (
                <ConversationRuns conversationId={conversationId} active />
              ) : null}
              {state.activeTab === "documents" ? (
                <ConversationDocuments
                  conversationId={conversationId}
                  active
                  onSelect={showDocument}
                />
              ) : null}
              {state.activeTab === "info" ? (
                <ConversationInfo conversationId={conversationId} active />
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center gap-1 py-2">
            <Button
              variant="ghost"
              size="icon"
              className="mb-2 size-8"
              aria-label={t("context.expand")}
              onClick={() => dispatch({ type: "toggle" })}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            {tabs.map(({ id, Icon, label }) => (
              <Button
                key={id}
                variant={state.activeTab === id ? "secondary" : "ghost"}
                size="icon"
                className="size-8"
                aria-label={label}
                title={label}
                onClick={() => dispatch({ type: "select-tab", tab: id })}
              >
                <Icon className="size-4" />
              </Button>
            ))}
          </div>
        )}
      </aside>
      {state.modalDocument ? (
        <DocumentPreview
          doc={state.modalDocument}
          onClose={() => dispatch({ type: "close-modal" })}
        />
      ) : null}
    </>
  );
}
