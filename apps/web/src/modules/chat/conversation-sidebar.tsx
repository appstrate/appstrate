// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type Dispatch, type ReactNode } from "react";
import { PanelRightCloseIcon, PanelRightIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNowTick } from "@appstrate/ui/use-now-tick";
import { useSessionDetail } from "@appstrate/module-chat/unread";
import { conversationStats } from "@appstrate/module-chat/conversation-stats";
import { cn } from "@appstrate/ui/cn";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { formatCompactTokens, formatTokenFigure } from "@appstrate/ui/context-window";
import { Button } from "@appstrate/ui/components/button";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@appstrate/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { CopyButton } from "@appstrate/ui/components/copy-button";
import { $api } from "../../api/client";
import { AgentDetailPaneHeader } from "../../components/agent-detail/agent-detail-split";
import { ErrorState } from "../../components/page-states";
import { FileArtifact } from "../../components/file-artifact";
import { RowSpaceName, RunRow } from "../../components/run-row";
import { TextSkeleton, Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { useAgents } from "../../hooks/use-packages";
import { useFile, useFiles } from "../../hooks/use-files";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useAdmittingSpaces } from "../../hooks/use-overview-mode";
import { useConversationTabs } from "./use-conversation-tabs";
import { useRunAgentName } from "../../hooks/use-run-agent-name";
import { useListScope } from "../../hooks/use-org-scope";
import { otherSpaceFileContext } from "../../lib/file-link";
import { localViewableFile } from "../../lib/files";
import { formatBytes } from "../../lib/format-bytes";
import { formatDateField, formatRelativeTime } from "../../lib/format-date";
import {
  shownFile,
  type ConversationSidebarAction,
  type ConversationSidebarState,
  type ConversationSidebarTab,
  type LocalSidebarFile,
  type SidebarFile,
  type StoredSidebarFile,
} from "./conversation-sidebar-state";
import { ChatAccessSummary } from "./chat-access-summary";
import { PanelResizeHandle } from "../../components/panel-resize";
import { usePanelWidth, type PanelView } from "./use-panel-width";
import { LG_AND_UP, useMediaQuery } from "../../hooks/use-media-query";

const CONVERSATION_CONTEXT_PANEL_ID = "conversation-context-panel";

/**
 * The panel's own frame: it floats beside the thread, so its card (and the
 * previewed file) is rounder than a page's and lifted by a light shadow.
 */
const FLOATING_FRAME = "overflow-hidden rounded-2xl shadow-xs";

/**
 * A tab's scroll inside the card: the design system's thin overlay bar. Radix
 * lays its content out as a table, whose width follows the longest name:
 * `block` keeps it to the card's, so a name truncates.
 */
const TAB_SCROLL = "h-full [&_[data-radix-scroll-area-viewport]>div]:!block";

/** A tab with nothing to list: one plain sentence, no illustration, in a card that stays small. */
function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-4 py-6 text-center text-sm">{children}</p>;
}

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
          size="icon-sm"
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
  const close = {
    label: backToList ? t("context.backToFiles") : t("context.collapse"),
    onClick: onClose,
  };
  return "local" in file ? (
    <ShownLocalFile file={file} onClose={close} />
  ) : (
    <ShownStoredFile file={file} onClose={close} />
  );
}

function ShownStoredFile({
  file,
  onClose,
}: {
  file: StoredSidebarFile;
  onClose: { label: string; onClick: () => void };
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
      onClose={onClose}
      className={cn("h-full", FLOATING_FRAME)}
    />
  );
}

/** A file picked in the composer: the same frame over the browser's own copy, nothing to fetch. */
function ShownLocalFile({
  file,
  onClose,
}: {
  file: LocalSidebarFile;
  onClose: { label: string; onClick: () => void };
}) {
  const { t } = useTranslation("chat");
  const viewable = localViewableFile(file.local, file.url);
  return (
    <FileArtifact
      fileId={viewable.id}
      file={viewable}
      isLoading={false}
      error={null}
      fallbackName={file.local.name || t("context.file.untitled")}
      onClose={onClose}
      className={cn("h-full", FLOATING_FRAME)}
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

  // A conversation not yet saved has launched nothing either: the same sentence.
  if (!conversationId) return <PanelEmpty>{t("context.runs.empty")}</PanelEmpty>;
  if (query.isLoading) return <TextSkeleton className="p-4" />;
  if (query.error) return <ErrorState error={query.error} compact />;
  const runs = query.data?.data ?? [];
  if (runs.length === 0) return <PanelEmpty>{t("context.runs.empty")}</PanelEmpty>;

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
  onSelect: (file: StoredSidebarFile) => void;
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

  if (!conversationId) return <PanelEmpty>{t("context.files.empty")}</PanelEmpty>;
  if (query.isLoading) return <TextSkeleton className="p-4" />;
  if (query.error) return <ErrorState error={query.error} compact />;
  const files = query.data?.data ?? [];
  if (files.length === 0) return <PanelEmpty>{t("context.files.empty")}</PanelEmpty>;

  return (
    <div className="divide-y">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          className="hover:bg-muted/50 flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors"
          onClick={() => onSelect({ id: file.id, name: file.name, spaceId: file.spaceId })}
        >
          <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
            <MimeIcon mime={file.mime} name={file.name} className="text-muted-foreground size-4" />
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

function InfoDate({ iso }: { iso: string }) {
  const now = useNowTick();
  return (
    <>
      <span>{formatRelativeTime(iso, now, "long")}</span>
      <span className="text-muted-foreground block text-xs">{formatDateField(iso)}</span>
    </>
  );
}

function ConversationId({ id }: { id: string }) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="text-muted-foreground flex items-center gap-1 text-xs">
      <code className="min-w-0 flex-1 truncate font-mono">{id}</code>
      <CopyButton
        value={id}
        className="desktop-pointer:size-6 shrink-0"
        aria-label={`${t("common:btn.copy")} (${t("chat:context.info.id")})`}
      />
    </div>
  );
}

/** The details while they load, row for row; a date row is two lines (age, then date). */
function ConversationDetailsSkeleton() {
  const row = (key: string, width: string, lines = 1) => (
    <div key={key}>
      <SkeletonLine className="w-20 text-xs" />
      <div className="mt-1">
        {Array.from({ length: lines }, (_, i) => (
          <SkeletonLine key={i} className={i ? "w-16 text-xs" : cn("text-sm", width)} />
        ))}
      </div>
    </div>
  );
  return (
    <Waiting className="divide-y">
      <div className="flex flex-col gap-4 p-4">
        <SkeletonLine className="w-2/3 text-base font-semibold" />
        <div className="flex flex-col gap-3">
          {row("created", "w-24", 2)}
          {row("activity", "w-24", 2)}
          {row("messages", "w-8")}
          {row("status", "w-16")}
        </div>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <SkeletonLine className="w-32 text-sm font-medium" />
        <div className="flex flex-col gap-3">
          {row("context", "w-28")}
          {row("models", "w-40")}
          {row("tokens", "w-36")}
        </div>
        <SkeletonLine className="w-3/4 text-xs" />
      </div>
    </Waiting>
  );
}

/**
 * The models that closed the conversation's turns and the context it carries, from the turns' own
 * metadata, beside the tokens every metered call consumed, from the server's ledger sum.
 */
export function ConversationUsage({
  session,
}: {
  session: NonNullable<ReturnType<typeof useSessionDetail>["data"]>;
}) {
  const { t, i18n } = useTranslation("chat");
  const { models, context } = conversationStats(session.messages);
  const { usage } = session;
  const read =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const generated = usage.output_tokens ?? 0;
  const metered = read + generated > 0;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t("context.info.usageTitle")}</h3>
      {models.length === 0 && !context && !metered ? (
        <p className="text-muted-foreground text-sm">{t("context.info.noTurn")}</p>
      ) : (
        <>
          <FactGrid columns={1}>
            {context ? (
              <Fact label={t("context.info.currentContext")}>
                <span className="whitespace-nowrap tabular-nums">
                  {t("contextUsage.counts", {
                    used: formatCompactTokens(context.tokens, i18n.language),
                    max: formatTokenFigure(
                      context.window,
                      context.windowAssumed === true,
                      i18n.language,
                    ),
                  })}
                </span>
                {context.windowAssumed === true ? (
                  <span className="text-muted-foreground block text-xs">
                    {t("contextUsage.windowAssumed", {
                      window: formatCompactTokens(context.window, i18n.language),
                    })}
                  </span>
                ) : null}
              </Fact>
            ) : null}
            {models.length > 0 ? (
              <Fact label={t("context.info.models", { count: models.length })}>
                <ul className="flex flex-col gap-0.5">
                  {models.map((model) => (
                    <li key={model.modelId}>
                      {model.failed > 0
                        ? t("context.info.modelTurnsFailed", {
                            model: model.label,
                            count: model.turns,
                            failed: model.failed,
                          })
                        : t("context.info.modelTurns", { model: model.label, count: model.turns })}
                    </li>
                  ))}
                </ul>
              </Fact>
            ) : null}
            {metered ? (
              <Fact label={t("context.info.tokens")}>
                {t("context.info.tokensReadGenerated", {
                  read: formatCompactTokens(read, i18n.language),
                  generated: formatCompactTokens(generated, i18n.language),
                })}
              </Fact>
            ) : null}
          </FactGrid>
          {metered ? (
            <p className="text-muted-foreground text-xs">{t("context.info.tokensScope")}</p>
          ) : null}
        </>
      )}
    </section>
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
    return <PanelEmpty>{t("context.info.empty")}</PanelEmpty>;
  }
  if (query.isLoading) return <ConversationDetailsSkeleton />;
  if (query.error || !query.data) return <ErrorState error={query.error} compact />;

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
      <div className="flex flex-col gap-4 p-4">
        <h3 className="text-base font-semibold break-words">
          {session.title || t("context.info.untitled")}
        </h3>
        <FactGrid columns={1}>
          {rows.map(([label, value]) => (
            <Fact key={label} label={label}>
              {value}
            </Fact>
          ))}
        </FactGrid>
      </div>
      <div className="p-4">
        <ConversationUsage session={session} />
      </div>
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
    <div className="divide-y">
      <ConversationDetails conversationId={conversationId} active={active} />
      <div className="p-4">
        <ChatAccessSummary conversation={conversation} />
      </div>
      {conversationId ? (
        <div className="px-4 py-2">
          <ConversationId id={conversationId} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The panel's content, in the desktop column or in the phone's sheet: one
 * surface, the tabs in its header and the tab's content under them (Radix wires
 * the tab/tabpanel ARIA). On desktop that surface is a card floating beside the
 * thread; in the phone's sheet, the sheet itself. A shown file replaces all of
 * it with the file's frame.
 */
function ConversationContext({
  conversationId,
  state,
  dispatch,
  closable,
}: {
  conversationId: string | null;
  state: ConversationSidebarState;
  dispatch: Dispatch<ConversationSidebarAction>;
  /**
   * The phone's sheet: it has no header toggle beside it, so it carries its own
   * close, and it is the surface (no card floating in it).
   */
  closable: boolean;
}) {
  // The desktop column stays mounted while closed (for its transition): its
  // reads wait until it is open.
  const active = state.expanded;
  const { t } = useTranslation("chat");
  const { tabs, activeTab } = useConversationTabs(state.activeTab);
  // Read from the state, not the readable tabs: a file the thread opens shows
  // even for a caller whose Files tab is not drawn.
  const previewedFile = shownFile(state);

  if (previewedFile) {
    return (
      <div className="h-full p-3">
        <ShownFile
          file={previewedFile}
          backToList={state.fileFromList}
          onClose={() => dispatch({ type: "close-file" })}
        />
      </div>
    );
  }

  const panel = (
    <Tabs
      value={activeTab.id}
      onValueChange={(tab) => dispatch({ type: "select-tab", tab: tab as ConversationSidebarTab })}
      className={cn(
        "flex min-h-0 flex-col",
        // On desktop the card is as tall as its content, from a floor to the column's height,
        // where its tab scrolls; the phone's sheet is the surface, its whole height.
        closable ? "h-full" : cn("bg-card min-h-64 shrink border", FLOATING_FRAME),
      )}
    >
      <AgentDetailPaneHeader className="h-12 min-h-12 gap-2 px-2">
        {/* The tabs are their icons, named by a tooltip and for a screen reader: the active one
            in the foreground on a light fill, the others muted, no track behind them. */}
        <TabsList className="h-auto gap-0.5 bg-transparent p-0" aria-label={t("context.label")}>
          {tabs.map(({ id, Icon, label }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <TabsTrigger
                  value={id}
                  aria-label={label}
                  className="text-muted-foreground hover:text-foreground data-[state=active]:bg-accent desktop-pointer:size-8 size-10 rounded-md p-0 data-[state=active]:shadow-none"
                >
                  <Icon className="size-4 shrink-0" />
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </TabsList>
        {closable ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto shrink-0"
            aria-label={t("context.collapse")}
            onClick={() => dispatch({ type: "toggle" })}
          >
            <XIcon />
          </Button>
        ) : null}
      </AgentDetailPaneHeader>
      {tabs.map(({ id }) => (
        <TabsContent key={id} value={id} className="mt-0 min-h-0 flex-1">
          <ScrollArea className={TAB_SCROLL}>
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
          </ScrollArea>
        </TabsContent>
      ))}
    </Tabs>
  );
  // On desktop the card floats in the column, inset as the shown file is, from its top.
  return closable ? panel : <div className="flex h-full flex-col p-3">{panel}</div>;
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
  const { activeTab } = useConversationTabs(state.activeTab);
  const view: PanelView = shownFile(state) ? "file" : activeTab.id === "info" ? "info" : "list";
  const size = usePanelWidth(panelRef, view);

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
          // The panel's header carries the one close control.
          showCloseButton={false}
          className="bg-background flex w-[min(92vw,36rem)] flex-col gap-0 p-0 sm:max-w-none"
        >
          <SheetTitle className="sr-only">{t("context.label")}</SheetTitle>
          <ConversationContext
            conversationId={conversationId}
            state={state}
            dispatch={dispatch}
            closable
          />
        </SheetContent>
      </Sheet>
    );
  }

  // The column keeps its place in the layout and animates its width: closed,
  // it is 0 wide and `inert` (out of the tab order and the accessibility tree).
  // Its content keeps the full width so nothing reflows mid-transition, and is
  // anchored right: switching views (list, details, file) widens or narrows
  // the column from its left edge, toward the thread.
  return (
    <aside
      ref={panelRef}
      id={CONVERSATION_CONTEXT_PANEL_ID}
      aria-label={t("context.label")}
      inert={!state.expanded}
      className={cn(
        "relative shrink-0 overflow-hidden",
        !dragging && "ease-surface transition-[width]",
        state.expanded ? "duration-base" : "duration-fast",
      )}
      style={{ width: state.expanded ? size.width : 0 }}
    >
      <div
        className={cn(
          "ease-surface absolute inset-y-0 right-0 transition-[opacity,translate]",
          state.expanded
            ? "duration-base translate-x-0 opacity-100"
            : "duration-fast translate-x-6 opacity-0",
        )}
        style={{ width: size.width }}
      >
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
        <ConversationContext
          conversationId={conversationId}
          state={state}
          dispatch={dispatch}
          closable={false}
        />
      </div>
    </aside>
  );
}
