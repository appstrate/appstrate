// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type Dispatch, type ReactNode } from "react";
import { ActivityIcon, FilesIcon, PanelRightCloseIcon, PanelRightIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConversationToolCall } from "@appstrate/module-chat/conversation-tools";
import { revealToolCall } from "@appstrate/module-chat/reveal-tool-call";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@appstrate/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { AgentDetailPaneHeader } from "../../components/agent-detail/agent-detail-split";
import { EmptyState, ErrorState } from "../../components/page-states";
import { FileArtifact } from "../../components/file-artifact";
import { RowSpaceName, RunRow } from "../../components/run-row";
import { TextSkeleton } from "../../components/loading-skeletons";
import { useFile } from "../../hooks/use-files";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useConversationTabs } from "./use-conversation-tabs";
import { otherSpaceFileContext } from "../../lib/file-link";
import { localViewableFile } from "../../lib/files";
import { formatBytes } from "../../lib/format-bytes";
import { formatDateField } from "../../lib/format-date";
import { useConversationFiles, useConversationRuns } from "./use-conversation-lists";
import { ConversationSummary } from "./conversation-summary";
import { ConversationToolsList, ShownToolCall } from "./conversation-tools-tab";
import {
  revealMissed,
  shownFile,
  shownToolCallId,
  type ConversationSidebarAction,
  type ConversationSidebarState,
  type ConversationSidebarTab,
  type LocalSidebarFile,
  type SidebarFile,
  type SidebarOrigin,
  type StoredSidebarFile,
} from "./conversation-sidebar-state";
import { PanelResizeHandle } from "./panel-resize";
import { usePanelWidth, type PanelView } from "./use-panel-width";
import { LG_AND_UP, useMediaQuery } from "../../hooks/use-media-query";

const CONVERSATION_CONTEXT_PANEL_ID = "conversation-context-panel";

/** The room left at the area's right edge for the thread's scrollbar, beside the floating panel. */
const SCROLLBAR_GUTTER = "1rem";

/**
 * The panel's own frame, ONE block whatever it shows (the tabs over their content, or a previewed
 * file): it floats over the thread, so it is rounder than a page's card and lifted by a light
 * shadow.
 */
const FLOATING_FRAME = "overflow-hidden rounded-2xl shadow-xs";

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

/** What closing a shown file does, said by its X: back where it was opened from. */
const FILE_CLOSE_LABEL: Record<SidebarOrigin, string> = {
  thread: "context.collapse",
  list: "context.backToFiles",
  summary: "context.backToSummary",
};

/**
 * The file's frame IS the panel: its header replaces the panel's. Its X closes
 * the panel, or goes back to the file list or the summary the file was opened from.
 */
export function ShownFile({
  file,
  from,
  onClose,
}: {
  file: SidebarFile;
  from: SidebarOrigin;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const close = { label: t(FILE_CLOSE_LABEL[from]), onClick: onClose };
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
  const { query, runs, agentName, agentById, spanning } = useConversationRuns(
    conversationId,
    active,
  );

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={ActivityIcon} compact />;
  }
  if (query.isLoading) {
    return <TextSkeleton className="p-4" />;
  }
  if (query.error) return <ErrorState error={query.error} compact />;
  if (runs.length === 0) {
    return <EmptyState message={t("context.runs.empty")} icon={ActivityIcon} compact />;
  }

  return (
    <div className="divide-y">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          agentName={agentName(run)}
          agent={run.packageId ? agentById.get(run.packageId) : undefined}
          dense
          spanning={spanning}
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
  const { query, files, named } = useConversationFiles(conversationId, active);

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={FilesIcon} compact />;
  }
  if (query.isLoading) {
    return <TextSkeleton className="p-4" />;
  }
  if (query.error) return <ErrorState error={query.error} compact />;
  if (files.length === 0) {
    return <EmptyState message={t("context.files.empty")} icon={FilesIcon} compact />;
  }

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

/**
 * The panel's content, in the desktop column or in the phone's sheet: one block, the tabs in its
 * header band (Radix wires the tab/tabpanel ARIA) over the selected tab's content. The block is as
 * tall as that content, up to the room it has; past it, the content scrolls inside. A shown file
 * replaces the block with the file's own, in the same frame, the whole height.
 */
function ConversationContext({
  conversationId,
  state,
  dispatch,
  closable,
  onShowInThread,
}: {
  conversationId: string | null;
  state: ConversationSidebarState;
  dispatch: Dispatch<ConversationSidebarAction>;
  /** The phone's sheet has no header toggle beside it: it carries its own close. */
  closable: boolean;
  /** "See in the thread": bring the call's card into view, where the panel leaves room for it. */
  onShowInThread: (call: ConversationToolCall) => void;
}) {
  // The desktop column stays mounted while closed (for its transition): its
  // reads wait until it is open. The phone's sheet unmounts its content when closed.
  const active = state.expanded;
  const { t } = useTranslation("chat");
  const { tabs, activeTab } = useConversationTabs(state.activeTab);
  // Read from the state, not the readable tabs: a file the thread opens shows
  // even for a caller whose Files tab is not drawn.
  const previewedFile = shownFile(state);
  const shownCall = shownToolCallId(state);

  if (previewedFile) {
    return (
      <div className="min-h-0 flex-1 p-3">
        <ShownFile
          file={previewedFile}
          from={state.fileFrom}
          onClose={() => dispatch({ type: "close-file" })}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col p-3">
      <Tabs
        value={activeTab.id}
        onValueChange={(tab) =>
          dispatch({ type: "select-tab", tab: tab as ConversationSidebarTab })
        }
        className={cn(
          "bg-card text-card-foreground flex min-h-0 flex-col gap-0 border",
          FLOATING_FRAME,
        )}
      >
        {/* Every tab keeps its name in words: a narrow panel drops the icons and tightens the
            tabs (as a detail page's do below `sm`), and scrolls them sideways if they still do
            not fit. 40 px tabs on touch, denser under a mouse. */}
        <AgentDetailPaneHeader className="@container justify-end gap-2">
          <div className="no-scrollbar scroll-fade-x min-w-0 overflow-x-auto">
            <TabsList className="h-auto w-max p-1" aria-label={t("context.label")}>
              {tabs.map(({ id, Icon, label }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="desktop-pointer:h-7 h-10 gap-1.5 px-2 @sm:px-3"
                >
                  <Icon aria-hidden="true" className="hidden size-4 shrink-0 @sm:block" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {closable ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={t("context.collapse")}
              onClick={() => dispatch({ type: "toggle" })}
            >
              <XIcon />
            </Button>
          ) : null}
        </AgentDetailPaneHeader>
        {tabs.map(({ id }) => (
          <TabsContent key={id} value={id} className="mt-0 min-h-0 overflow-auto">
            {id === "runs" ? (
              <ConversationRuns conversationId={conversationId} active={active} />
            ) : null}
            {id === "files" ? (
              <ConversationFiles
                conversationId={conversationId}
                active={active}
                onSelect={(file) => dispatch({ type: "show-file", file, from: "list" })}
              />
            ) : null}
            {id === "tools" ? (
              shownCall ? (
                <ShownToolCall
                  key={shownCall}
                  conversationId={conversationId}
                  toolCallId={shownCall}
                  active={active}
                  missing={revealMissed(state)}
                  from={state.toolCallFrom}
                  onBack={() => dispatch({ type: "close-tool-call" })}
                  onShowInThread={onShowInThread}
                />
              ) : (
                <ConversationToolsList
                  conversationId={conversationId}
                  active={active}
                  showLookups={state.showLookups}
                  onShowLookupsChange={(show) => dispatch({ type: "show-lookups", show })}
                  onSelect={(call) =>
                    dispatch({ type: "show-tool-call", toolCallId: call.toolCallId, from: "list" })
                  }
                />
              )
            ) : null}
            {id === "summary" ? (
              <ConversationSummary
                conversationId={conversationId}
                active={active}
                dispatch={dispatch}
              />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export function ConversationSidebar({
  conversationId,
  state,
  dispatch,
  children,
}: {
  conversationId: string | null;
  state: ConversationSidebarState;
  dispatch: Dispatch<ConversationSidebarAction>;
  /** The thread: the panel opens over its right side. */
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const desktop = useMediaQuery(LG_AND_UP);
  const panelRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  // The call "See in the thread" waits to reveal until the phone's sheet has closed.
  const pendingReveal = useRef<ConversationToolCall | null>(null);
  const { activeTab } = useConversationTabs(state.activeTab);
  const reveal = (call: ConversationToolCall) =>
    // Missed, the panel opens again on the call to say so.
    dispatch({ type: "revealed", toolCallId: call.toolCallId, found: revealToolCall(call) });
  const showInThread = (call: ConversationToolCall) => {
    if (desktop) {
      // The panel floats beside the thread: the card is revealed in place.
      reveal(call);
      return;
    }
    // The phone's sheet covers the thread: it closes first, and the card is revealed once it has,
    // in place of the focus the sheet would give back to its trigger (`onCloseAutoFocus`).
    pendingReveal.current = call;
    dispatch({ type: "toggle" });
  };
  // The summary and a tool call's detail take a little more than a list.
  const view: PanelView = shownFile(state)
    ? "file"
    : activeTab.id === "summary" || shownToolCallId(state)
      ? "detail"
      : "list";
  const size = usePanelWidth(panelRef, view);

  // Desktop: the panel floats over the thread's right side, inside the conversation. The thread
  // keeps the whole width, so its scrollbar stays at the right edge, outside the panel (`right-4`,
  // the scrollbar's gutter), and reserves the room the panel and that gutter take
  // (`--chat-context-inset`, read by the module's side padding): nothing reads under it and the
  // column stays centered in what is left. Closed, the panel is `inert` (out of the tab order and
  // the accessibility tree) and lets the pointer through; its content keeps the full width so
  // nothing reflows mid-transition. Below `lg` it opens in a sheet.
  const inset =
    desktop && state.expanded ? `calc(${size.width}px + ${SCROLLBAR_GUTTER})` : undefined;
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      style={{ ["--chat-context-inset" as string]: inset }}
    >
      {/* While the panel is resized, the thread's padding follows the pointer, not its transition.
          `isolate` keeps the thread's raised layers (a card's space name is `z-10`) under the panel. */}
      <div className={cn("isolate min-w-0 flex-1", dragging && "[&_*]:transition-none")}>
        {children}
      </div>
      {desktop ? (
        <aside
          ref={panelRef}
          id={CONVERSATION_CONTEXT_PANEL_ID}
          aria-label={t("context.label")}
          inert={!state.expanded}
          className={cn(
            "ease-surface absolute top-0 right-4 flex max-h-full flex-col transition-[opacity,translate]",
            // A file takes the whole height; the tabs' block is as tall as its content.
            view === "file" && "bottom-0",
            state.expanded
              ? "duration-base translate-x-0 opacity-100"
              : "duration-fast pointer-events-none translate-x-6 opacity-0",
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
            onShowInThread={showInThread}
          />
        </aside>
      ) : (
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
            className="bg-canvas flex w-[min(92vw,36rem)] flex-col gap-0 p-0 sm:max-w-none"
            onCloseAutoFocus={(event) => {
              const call = pendingReveal.current;
              if (!call) return;
              pendingReveal.current = null;
              // The revealed card takes the focus, not the toggle that opened the sheet.
              event.preventDefault();
              reveal(call);
            }}
          >
            <SheetTitle className="sr-only">{t("context.label")}</SheetTitle>
            <ConversationContext
              conversationId={conversationId}
              state={state}
              dispatch={dispatch}
              closable
              onShowInThread={showInThread}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
