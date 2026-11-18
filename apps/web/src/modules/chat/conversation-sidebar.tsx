// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type Dispatch, type ReactNode } from "react";
import { CheckIcon, CopyIcon, PanelRightCloseIcon, PanelRightIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { relativeAge } from "@appstrate/core/format";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@appstrate/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { useCopyToClipboard } from "@appstrate/ui/use-copy-to-clipboard";
import { $api } from "../../api/client";
import { AgentDetailPaneHeader } from "../../components/agent-detail/agent-detail-split";
import { FileArtifact } from "../../components/file-artifact";
import { MimeIcon } from "../../components/file-badges";
import { RowSpaceName, RunRow } from "../../components/run-row";
import { TextSkeleton } from "../../components/loading-skeletons";
import { useAgents } from "../../hooks/use-packages";
import { useFile, useFiles } from "../../hooks/use-files";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useAdmittingSpaces } from "../../hooks/use-overview-mode";
import { useConversationTabs } from "./use-conversation-tabs";
import { useRunAgentName } from "../../hooks/use-run-agent-name";
import { useListScope } from "../../hooks/use-org-scope";
import { otherSpaceFileContext } from "../../lib/file-link";
import { formatBytes } from "../../lib/format-bytes";
import { formatDateField } from "../../lib/format-date";
import type {
  ConversationSidebarAction,
  ConversationSidebarState,
  ConversationSidebarTab,
  SidebarFile,
} from "./conversation-sidebar-state";
import { ChatAccessSummary } from "./chat-access-summary";
import { PanelResizeHandle } from "./panel-resize";
import { usePanelWidth } from "./use-panel-width";
import { LG_AND_UP, useMediaQuery } from "../../hooks/use-media-query";

const CONVERSATION_CONTEXT_PANEL_ID = "conversation-context-panel";

/** The shell header's one control for the context panel, wherever it is drawn. */
export function ConversationContextToggle({
  expanded,
  dispatch,
}: {
  expanded: boolean;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  const { t } = useTranslation("chat");
  const label = expanded ? t("context.hide") : t("context.show");
  const Icon = expanded ? PanelRightCloseIcon : PanelRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={CONVERSATION_CONTEXT_PANEL_ID}
          onClick={() => dispatch({ type: "toggle" })}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function PanelState({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
      {children}
    </div>
  );
}

/**
 * The file's frame IS the panel: its header replaces the panel's. Its X closes
 * the panel, or goes back to the file list the file was opened from.
 */
export function ShownFile({
  file,
  backToList,
  onClose,
}: {
  file: SidebarFile;
  backToList: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  // A file of another space (a conversation's) is read, copied and downloaded there.
  const context = otherSpaceFileContext(file.spaceId, useCurrentOrgId(), useCurrentSpaceId());
  const { data, isLoading, error } = useFile(file.id, context);

  return (
    <FileArtifact
      fileId={file.id}
      context={context}
      file={data}
      isLoading={isLoading}
      error={error}
      fallbackName={file.name || t("context.file.untitled")}
      onClose={{
        label: backToList ? t("context.backToFiles") : t("context.collapse"),
        onClick: onClose,
      }}
      className="h-full rounded-none border-0"
    />
  );
}

export function ConversationRuns({
  conversationId,
  active,
}: {
  conversationId: string | null;
  active: boolean;
}) {
  const { t } = useTranslation("chat");
  const admitting = useAdmittingSpaces("runs");
  const canRead = admitting.length > 0;
  // Spanning: the conversation's runs are every space's, polled (the SSE stream carries one space).
  const scope = useListScope(true, canRead);
  // Their agents are every space's too: read from the index spanning spaces, while shown.
  const shown = active && !!conversationId;
  const { data: agents } = useAgents({ spanning: true, enabled: shown });
  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent] as const));
  const agentName = useRunAgentName({ spanning: true, enabled: shown });
  const filters = { chat_session_id: conversationId ?? undefined, limit: 100 };
  // A conversation belongs to the organization: the runs it launched, in every space.
  const query = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/runs",
    { params: { path: { orgId: scope.orgId ?? "" }, query: filters } },
    {
      enabled: scope.enabled && canRead && active && !!conversationId,
      refetchInterval: scope.refetchInterval,
    },
  );

  if (!conversationId) return <PanelState>{t("context.unsaved")}</PanelState>;
  if (query.isLoading) return <TextSkeleton className="p-4" />;
  if (query.error) return <PanelState>{t("context.error")}</PanelState>;
  const runs = query.data?.data ?? [];
  if (runs.length === 0) return <PanelState>{t("context.runs.empty")}</PanelState>;

  return (
    <div className="divide-y">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          agentName={agentName(run)}
          agent={run.packageId ? agentById.get(run.packageId) : undefined}
          dense
          // The list spans the spaces the reader reads runs in: each row names its own once
          // there are several.
          spanning={admitting.length > 1}
          className="px-3"
        />
      ))}
    </div>
  );
}

export function ConversationFiles({
  conversationId,
  active,
  onSelect,
}: {
  conversationId: string | null;
  active: boolean;
  onSelect: (file: SidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  // The list spans the spaces the reader reads files in: each row names its own once there are several.
  const named = useAdmittingSpaces("files").length > 1;
  const query = useFiles({
    spanning: true,
    contextChatSessionId: conversationId ?? undefined,
    limit: 100,
    enabled: active && !!conversationId,
  });

  if (!conversationId) return <PanelState>{t("context.unsaved")}</PanelState>;
  if (query.isLoading) return <TextSkeleton className="p-4" />;
  if (query.error) return <PanelState>{t("context.error")}</PanelState>;
  const files = query.data?.data ?? [];
  if (files.length === 0) return <PanelState>{t("context.files.empty")}</PanelState>;

  return (
    <div className="divide-y">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          className="hover:bg-muted/40 flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors"
          onClick={() => onSelect({ id: file.id, name: file.name, spaceId: file.spaceId })}
        >
          <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
            <MimeIcon mime={file.mime} className="text-muted-foreground size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{file.name}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {[
                file.purpose === "user_upload"
                  ? t("context.files.attachment")
                  : t("context.files.output"),
                formatBytes(file.size),
                formatDateField(file.createdAt, "date"),
              ].join(" · ")}
            </span>
          </span>
          {named && <RowSpaceName spaceId={file.spaceId} />}
        </button>
      ))}
    </div>
  );
}

/** « il y a 3 jours », in the interface's language; the age's units come from core. */
function formatAge(iso: string, language: string): string {
  const age = relativeAge(iso, Date.now());
  if (!age) return "";
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  return age.unit === "now" ? rtf.format(0, "second") : rtf.format(-age.count, age.unit);
}

function InfoDate({ iso }: { iso: string }) {
  const { i18n } = useTranslation();
  return (
    <>
      <span>{formatAge(iso, i18n.language)}</span>
      <span className="text-muted-foreground block text-xs">{formatDateField(iso)}</span>
    </>
  );
}

function ConversationId({ id }: { id: string }) {
  const { t } = useTranslation(["chat", "common"]);
  const { copy, copied } = useCopyToClipboard();
  return (
    <div className="text-muted-foreground flex items-center gap-1 text-xs">
      <code className="min-w-0 flex-1 truncate font-mono">{id}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={`${t("common:btn.copy")} (${t("chat:context.info.id")})`}
        onClick={() => void copy(id)}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

function ConversationDetails({
  conversationId,
  active,
}: {
  conversationId: string | null;
  active: boolean;
}) {
  const { t } = useTranslation("chat");
  const query = useSessionDetail(active ? conversationId : null);

  if (!conversationId) {
    return <p className="text-muted-foreground text-sm">{t("context.unsaved")}</p>;
  }
  if (query.isLoading) return <TextSkeleton />;
  if (query.error || !query.data) {
    return <p className="text-muted-foreground text-sm">{t("context.error")}</p>;
  }

  const session = query.data;
  const rows: [string, ReactNode][] = [
    [t("context.info.created"), <InfoDate key="created" iso={session.createdAt} />],
    [t("context.info.lastActivity"), <InfoDate key="activity" iso={session.updatedAt} />],
    [t("context.info.messages"), String(session.messages.length)],
    [
      t("context.info.status"),
      session.generating ? t("context.info.generating") : t("context.info.idle"),
    ],
  ];

  return (
    <>
      <h3 className="text-base font-semibold break-words">
        {session.title || t("context.info.untitled")}
      </h3>
      <dl className="flex flex-col gap-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function ConversationInfo({
  conversationId,
  active,
}: {
  conversationId: string | null;
  active: boolean;
}) {
  // The same query as the details': the access judges the conversation's own scope.
  const detail = useSessionDetail(active ? conversationId : null);
  const conversation = !conversationId
    ? null
    : detail.isLoading
      ? undefined
      : (detail.data ?? null);
  return (
    <div className="flex flex-col gap-5 p-4">
      <ConversationDetails conversationId={conversationId} active={active} />
      <ChatAccessSummary conversation={conversation} />
      {conversationId ? <ConversationId id={conversationId} /> : null}
    </div>
  );
}

/**
 * The panel's content, in the desktop column or in the phone's sheet. The tabs
 * sit in a header band of their own (Radix wires the tab/tabpanel ARIA); a
 * shown file replaces all of it with the file's frame.
 */
function ConversationContext({
  conversationId,
  state,
  dispatch,
}: {
  conversationId: string | null;
  state: ConversationSidebarState;
  dispatch: Dispatch<ConversationSidebarAction>;
}) {
  // The desktop column stays mounted while closed (for its transition): its
  // reads wait until it is open.
  const active = state.expanded;
  const { t } = useTranslation("chat");
  const { tabs, activeTab } = useConversationTabs(state.activeTab);
  // Read from the state, not the readable tabs: a file the thread opens shows
  // even for a caller whose Files tab is not drawn.
  const previewedFile = state.activeTab === "files" ? state.selectedFile : null;

  if (previewedFile) {
    return (
      <ShownFile
        file={previewedFile}
        backToList={state.fileFromList}
        onClose={() => dispatch({ type: "close-file" })}
      />
    );
  }

  return (
    <Tabs
      value={activeTab.id}
      onValueChange={(tab) => dispatch({ type: "select-tab", tab: tab as ConversationSidebarTab })}
      className="flex h-full min-h-0 flex-col"
    >
      <AgentDetailPaneHeader className="gap-2">
        <TabsList className="h-9 min-w-0" aria-label={t("context.label")}>
          {tabs.map(({ id, Icon, label }) => (
            <TabsTrigger key={id} value={id} className="gap-1.5">
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-8 shrink-0"
          aria-label={t("context.collapse")}
          onClick={() => dispatch({ type: "toggle" })}
        >
          <XIcon />
        </Button>
      </AgentDetailPaneHeader>
      {tabs.map(({ id }) => (
        <TabsContent key={id} value={id} className="mt-0 min-h-0 flex-1 overflow-auto">
          {id === "runs" ? (
            <ConversationRuns conversationId={conversationId} active={active} />
          ) : null}
          {id === "files" ? (
            <ConversationFiles
              conversationId={conversationId}
              active={active}
              onSelect={(file) => dispatch({ type: "show-file", file, fromList: true })}
            />
          ) : null}
          {id === "info" ? (
            <ConversationInfo conversationId={conversationId} active={active} />
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
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
  const desktop = useMediaQuery(LG_AND_UP);
  const panelRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const size = usePanelWidth(panelRef);

  if (!desktop) {
    return (
      <Sheet
        open={state.expanded}
        onOpenChange={(open) => open !== state.expanded && dispatch({ type: "toggle" })}
      >
        <SheetContent
          id={CONVERSATION_CONTEXT_PANEL_ID}
          side="right"
          aria-describedby={undefined}
          // The panel's header carries the one close control, as on desktop.
          showCloseButton={false}
          className="bg-card flex w-[min(92vw,36rem)] flex-col gap-0 p-0 sm:max-w-none"
        >
          <SheetTitle className="sr-only">{t("context.label")}</SheetTitle>
          <ConversationContext conversationId={conversationId} state={state} dispatch={dispatch} />
        </SheetContent>
      </Sheet>
    );
  }

  // The column keeps its place in the layout and animates its width: closed,
  // it is 0 wide and `inert` (out of the tab order and the accessibility tree).
  // Its content keeps the full width so nothing reflows mid-transition.
  return (
    <aside
      ref={panelRef}
      id={CONVERSATION_CONTEXT_PANEL_ID}
      aria-label={t("context.label")}
      inert={!state.expanded}
      className={cn(
        "relative shrink-0 overflow-hidden",
        !dragging && "duration-base ease-surface transition-[width] motion-reduce:transition-none",
      )}
      style={{ width: state.expanded ? size.width : 0 }}
    >
      <div className="bg-card absolute inset-y-0 right-0 border-l" style={{ width: size.width }}>
        <PanelResizeHandle
          controls={CONVERSATION_CONTEXT_PANEL_ID}
          label={t("context.resize")}
          width={size.width}
          min={size.min}
          max={size.max}
          clamp={size.clamp}
          onLive={size.setLive}
          onCommit={size.commit}
          onDraggingChange={setDragging}
        />
        <ConversationContext conversationId={conversationId} state={state} dispatch={dispatch} />
      </div>
    </aside>
  );
}
