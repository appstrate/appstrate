// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type Dispatch, type ReactNode } from "react";
import { FilesIcon, PanelRightCloseIcon, PanelRightIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { revealThreadItem } from "@appstrate/module-chat/reveal-tool-call";
import type { ThreadItem } from "@appstrate/module-chat/ui";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@appstrate/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { AgentDetailPaneHeader } from "../../components/agent-detail/agent-detail-split";
import { EmptyState, ErrorState } from "../../components/page-states";
import { FileArtifact } from "../../components/file-artifact";
import { TextSkeleton } from "../../components/loading-skeletons";
import { useFile } from "../../hooks/use-files";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useConversationTabs } from "./use-conversation-tabs";
import { otherSpaceFileContext } from "../../lib/file-link";
import { localViewableFile } from "../../lib/files";
import { readShown, useConversationFiles } from "./use-conversation-lists";
import { ConversationInfo } from "./conversation-info";
import { ConversationSummary } from "./conversation-summary";
import { ConversationToolsList } from "./conversation-tools-tab";
import { ConversationRuns } from "./conversation-runs-tab";
import { ConversationFileRow } from "./conversation-file-row";
import { openItemTrigger } from "./use-open-item";
import {
  openRunId,
  openToolCallId,
  revealMissed,
  shownFile,
  type ConversationSidebarAction,
  type ConversationSidebarState,
  type ConversationSidebarTab,
  type LocalSidebarFile,
  type SidebarFile,
  type SidebarOrigin,
  type StoredSidebarFile,
} from "./conversation-sidebar-state";
import { PanelResizeHandle } from "@/components/panel-resize";
import { useContextPanelWidth } from "./use-context-panel-width";
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
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-expanded={expanded}
            aria-controls={CONVERSATION_CONTEXT_PANEL_ID}
            onClick={() => dispatch({ type: "toggle" })}
          />
        }
      >
        <Icon />
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
  runs: "context.backToRuns",
};

/**
 * The file's frame IS the panel: its header replaces the panel's. Its X closes the panel, or goes
 * back to the file list, the summary or the run the file was opened from.
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
  const read = readShown(query);
  if (read === "error") return <ErrorState error={query.error} compact />;
  // Pending covers a read not yet answered and one held while the panel is closed.
  if (read === "pending") return <TextSkeleton className="p-4" />;
  if (files.length === 0) {
    return <EmptyState message={t("context.files.empty")} icon={FilesIcon} compact />;
  }

  return (
    <div className="divide-y">
      {files.map((file) => (
        <ConversationFileRow key={file.id} file={file} named={named} onSelect={onSelect} />
      ))}
    </div>
  );
}

/**
 * The panel's content, in the desktop column or in the phone's sheet: one block, the tabs in its
 * header band (Base UI wires the tab/tabpanel ARIA) over the selected tab's content. The block is as
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
  /** "See in the thread": bring a call's or a run's line into view, where the panel leaves room for it. */
  onShowInThread: (item: ThreadItem) => void;
}) {
  // The desktop column stays mounted while closed (for its transition): its
  // reads wait until it is open. The phone's sheet unmounts its content when closed.
  const active = state.expanded;
  const { t } = useTranslation("chat");
  const { tabs, activeTab } = useConversationTabs(state.activeTab);
  // Read from the state, not the readable tabs: a file the thread opens shows
  // even for a caller whose Files tab is not drawn.
  const previewedFile = shownFile(state);

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
        {/* One icon per tab, its name as the accessible name and in a tooltip: the tabs fit
            any panel width. 40 px targets on touch, denser under a mouse. */}
        <AgentDetailPaneHeader className="justify-between gap-2">
          <TabsList className="h-auto p-1" aria-label={t("context.label")}>
            {tabs.map(({ id, Icon, label }) => (
              <Tooltip key={id}>
                <TooltipTrigger
                  render={
                    <TabsTrigger
                      value={id}
                      aria-label={label}
                      className="desktop-pointer:size-7 size-10 px-0"
                    />
                  }
                >
                  <Icon aria-hidden="true" className="size-4" />
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            ))}
          </TabsList>
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
              <ConversationRuns
                conversationId={conversationId}
                active={active}
                openRunId={openRunId(state)}
                missing={revealMissed(state)}
                onOpenChange={(run, open) =>
                  dispatch(
                    open
                      ? { type: "show-item", item: { kind: "run", id: run.id } }
                      : { type: "close-item" },
                  )
                }
                onShowInThread={(run) => onShowInThread({ kind: "run", id: run.id })}
                onSelectFile={(file) => dispatch({ type: "show-file", file, from: "runs" })}
              />
            ) : null}
            {id === "files" ? (
              <ConversationFiles
                conversationId={conversationId}
                active={active}
                onSelect={(file) => dispatch({ type: "show-file", file, from: "list" })}
              />
            ) : null}
            {id === "tools" ? (
              <ConversationToolsList
                conversationId={conversationId}
                active={active}
                showLookups={state.showLookups}
                onShowLookupsChange={(show) => dispatch({ type: "show-lookups", show })}
                openToolCallId={openToolCallId(state)}
                missing={revealMissed(state)}
                onOpenChange={(call, open) =>
                  dispatch(
                    open
                      ? { type: "show-item", item: { kind: "call", id: call.toolCallId } }
                      : { type: "close-item" },
                  )
                }
                onShowInThread={(call) => onShowInThread({ kind: "call", id: call.toolCallId })}
              />
            ) : null}
            {id === "summary" ? (
              <ConversationSummary
                conversationId={conversationId}
                active={active}
                dispatch={dispatch}
              />
            ) : null}
            {id === "info" ? (
              <ConversationInfo conversationId={conversationId} active={active} />
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
  // The line "See in the thread" asked for, while the phone's sheet closes over the thread.
  const pendingReveal = useRef<ThreadItem | null>(null);
  const reveal = (item: ThreadItem) => {
    // Missed, the panel opens again on the call or the run to say so.
    dispatch({ type: "revealed", item, found: revealThreadItem(item) });
  };
  const showInThread = (item: ThreadItem) => {
    if (desktop) {
      reveal(item);
      return;
    }
    // Revealed once the sheet has closed and the thread is interactive again.
    pendingReveal.current = item;
    dispatch({ type: "toggle" });
  };
  // The sheet unmounts when the viewport crosses to desktop, so its close never consumes the reveal.
  useEffect(() => {
    if (desktop) pendingReveal.current = null;
  }, [desktop]);
  const size = useContextPanelWidth(panelRef);

  // Desktop: the panel floats over the thread, which keeps the whole width so its scrollbar stays
  // outside the panel, and reserves the panel's room (`--chat-context-inset`, read by the module's
  // side padding). Closed, the panel keeps its width so nothing reflows mid-transition.
  const inset =
    desktop && state.expanded ? `calc(${size.width}px + ${SCROLLBAR_GUTTER})` : undefined;
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      style={{ ["--chat-context-inset" as string]: inset }}
    >
      {/* While the panel is resized, the thread's padding follows the pointer, not its transition.
          `isolate` keeps the thread's raised layers (a line's space name is `z-10`) under the panel. */}
      <div className={cn("isolate min-w-0 flex-1", size.dragging && "[&_*]:transition-none")}>
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
            shownFile(state) && "bottom-0",
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
            onDraggingChange={size.setDragging}
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
          onOpenChangeComplete={(open) => {
            const item = pendingReveal.current;
            if (open || !item) return;
            pendingReveal.current = null;
            reveal(item);
          }}
        >
          <SheetContent
            id={CONVERSATION_CONTEXT_PANEL_ID}
            side="right"
            // The panel's header carries the one close control.
            showCloseButton={false}
            className="bg-canvas flex w-[min(92vw,36rem)] flex-col gap-0 p-0 sm:max-w-none"
            // An item opened from the thread takes the focus; the default otherwise.
            initialFocus={() =>
              openItemTrigger(document.getElementById(CONVERSATION_CONTEXT_PANEL_ID)) ?? true
            }
            // The revealed line takes the focus, not the toggle that opened the sheet.
            finalFocus={() => pendingReveal.current === null}
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
