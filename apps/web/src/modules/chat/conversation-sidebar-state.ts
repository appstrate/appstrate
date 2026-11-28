// SPDX-License-Identifier: Apache-2.0

import type { ThreadItem } from "@appstrate/module-chat/ui";

export type ConversationSidebarTab = "summary" | "runs" | "files" | "tools" | "info";

export interface StoredSidebarFile {
  id: string;
  name: string;
  /** The file's space when it is not the working one (a conversation's file elsewhere). */
  spaceId?: string;
}

/** A file picked in the composer, not yet sent: the browser's copy behind an object URL. */
export interface LocalSidebarFile {
  local: File;
  url: string;
}

export type SidebarFile = StoredSidebarFile | LocalSidebarFile;

/**
 * Where a file shown over the Files tab was opened from, so closing it goes back there: the thread
 * (closing the file closes the panel), the tab's list, the summary, or a run open in the Runs tab.
 */
export type SidebarOrigin = "thread" | "list" | "summary" | "runs";

export interface ConversationSidebarState {
  expanded: boolean;
  activeTab: ConversationSidebarTab;
  /** The file shown over the Files tab, null when the tab shows its list. */
  selectedFile: SidebarFile | null;
  fileFrom: SidebarOrigin;
  /** The call (Tools list) or the run (Runs list) held open, null when every line is folded. */
  selectedItem: ThreadItem | null;
  /** "See in the thread" looked for the open item in the thread and did not find it. */
  revealMissed: boolean;
  /** The Tools tab lists the lookups beside the actions. */
  showLookups: boolean;
}

export type ConversationSidebarAction =
  | { type: "toggle" }
  | { type: "select-tab"; tab: ConversationSidebarTab }
  | { type: "show-file"; file: SidebarFile; from?: SidebarOrigin }
  | { type: "close-file" }
  | { type: "show-item"; item: ThreadItem }
  | { type: "close-item" }
  | { type: "revealed"; item: ThreadItem; found: boolean }
  | { type: "show-lookups"; show: boolean }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "summary",
  selectedFile: null,
  fileFrom: "thread",
  selectedItem: null,
  revealMissed: false,
  showLookups: false,
};

/** Every line folded, no reveal pending: what opening the panel or a tab starts from. */
const FOLDED = { selectedItem: null, revealMissed: false } as const;

/** The tab whose list holds an item: a call's in the Tools tab, a run's in the Runs tab. */
const TAB_OF: Record<ThreadItem["kind"], ConversationSidebarTab> = { call: "tools", run: "runs" };

function showItem(state: ConversationSidebarState, item: ThreadItem): ConversationSidebarState {
  return {
    ...state,
    expanded: true,
    activeTab: TAB_OF[item.kind],
    selectedItem: item,
    revealMissed: false,
  };
}

/**
 * State behind the chat's context panel. Collapsing keeps the shown file, so it stays drawn while
 * the panel slides out; the next opening drops it. A reveal that missed (the phone's sheet closed
 * for it) opens the panel again on the item, saying so.
 */
export function conversationSidebarReducer(
  state: ConversationSidebarState,
  action: ConversationSidebarAction,
): ConversationSidebarState {
  switch (action.type) {
    case "toggle":
      return state.expanded
        ? { ...state, expanded: false }
        : { ...state, ...FOLDED, expanded: true, selectedFile: null };
    case "select-tab":
      return { ...state, ...FOLDED, expanded: true, activeTab: action.tab, selectedFile: null };
    case "show-file":
      return {
        ...state,
        expanded: true,
        activeTab: "files",
        selectedFile: action.file,
        fileFrom: action.from ?? "thread",
      };
    case "close-file":
      return {
        ...state,
        selectedFile: null,
        ...(state.fileFrom === "thread" ? { expanded: false } : {}),
        ...(state.fileFrom === "summary" || state.fileFrom === "runs"
          ? { activeTab: state.fileFrom }
          : {}),
      };
    case "show-item":
      return showItem(state, action.item);
    case "close-item":
      return { ...state, ...FOLDED };
    case "revealed":
      return action.found
        ? { ...state, revealMissed: false }
        : { ...showItem(state, action.item), revealMissed: true };
    case "show-lookups":
      return { ...state, showLookups: action.show };
    case "conversation-change":
      return { ...state, ...FOLDED, selectedFile: null };
  }
}

/** The file the panel shows over the Files tab, null while it shows a tab's content. */
export function shownFile(state: ConversationSidebarState): SidebarFile | null {
  return state.activeTab === "files" ? state.selectedFile : null;
}

/** The item its tab's list holds open, null while another tab shows or every line is folded. */
function openItem(state: ConversationSidebarState): ThreadItem | null {
  const item = state.selectedItem;
  return item && state.activeTab === TAB_OF[item.kind] ? item : null;
}

/** The call the Tools list holds open, null while another tab shows or every line is folded. */
export function openToolCallId(state: ConversationSidebarState): string | null {
  const item = openItem(state);
  return item?.kind === "call" ? item.id : null;
}

/** The run the Runs list holds open, null while another tab shows or every line is folded. */
export function openRunId(state: ConversationSidebarState): string | null {
  const item = openItem(state);
  return item?.kind === "run" ? item.id : null;
}

/**
 * The open run the list must be read again for: one it does not hold (launched since its last
 * poll), unless it was already read again for it (`asked`), so a run that is not the
 * conversation's is not read for forever.
 */
export function openRunToRefetch(
  runId: string | null,
  runs: readonly { id: string }[],
  asked: string | null,
): string | null {
  if (!runId || runId === asked || runs.some((run) => run.id === runId)) return null;
  return runId;
}

/** The open run is still absent from the list once it was read again for it (`refetchedFor`). */
export function openRunUnlisted(
  runId: string | null,
  runs: readonly { id: string }[] | undefined,
  refetchedFor: string | null,
): boolean {
  return (
    runId !== null &&
    runId === refetchedFor &&
    runs !== undefined &&
    !runs.some((run) => run.id === runId)
  );
}

/** Whether "See in the thread" missed the call's line or the run's line its list holds open. */
export function revealMissed(state: ConversationSidebarState): boolean {
  return openItem(state) !== null && state.revealMissed;
}

/**
 * The object URL of the picked file the panel holds, revoked once it holds another or none. A
 * collapsed panel still holds it: it stays drawn while the panel slides out.
 */
export function heldLocalUrl(state: ConversationSidebarState): string | null {
  return state.selectedFile && "local" in state.selectedFile ? state.selectedFile.url : null;
}
