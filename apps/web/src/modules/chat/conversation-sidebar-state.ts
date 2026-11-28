// SPDX-License-Identifier: Apache-2.0

export type ConversationSidebarTab = "summary" | "runs" | "files" | "tools";

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

/** A card "See in the thread" looks for: a call's, or a run's, by its id. */
export interface RevealTarget {
  kind: "call" | "run";
  id: string;
}

export interface ConversationSidebarState {
  expanded: boolean;
  activeTab: ConversationSidebarTab;
  /** The file shown over the Files tab, null when the tab shows its list. */
  selectedFile: SidebarFile | null;
  fileFrom: SidebarOrigin;
  /** The call the Tools list holds open, null when every line is folded. */
  selectedToolCallId: string | null;
  /** The run the Runs list holds open, null when every line is folded. */
  selectedRunId: string | null;
  /** "See in the thread" looked for the open call's or run's card and did not find it. */
  revealMissed: boolean;
  /** The Tools tab lists the lookups beside the actions. */
  showLookups: boolean;
}

export type ConversationSidebarAction =
  | { type: "toggle" }
  | { type: "select-tab"; tab: ConversationSidebarTab }
  | { type: "show-file"; file: SidebarFile; from?: SidebarOrigin }
  | { type: "close-file" }
  | { type: "show-tool-call"; toolCallId: string }
  | { type: "close-tool-call" }
  | { type: "show-run"; runId: string }
  | { type: "close-run" }
  | { type: "revealed"; target: RevealTarget; found: boolean }
  | { type: "show-lookups"; show: boolean }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "summary",
  selectedFile: null,
  fileFrom: "thread",
  selectedToolCallId: null,
  selectedRunId: null,
  revealMissed: false,
  showLookups: false,
};

/** Every line folded, no reveal pending: what opening the panel or a tab starts from. */
const FOLDED = { selectedToolCallId: null, selectedRunId: null, revealMissed: false } as const;

function showToolCall(
  state: ConversationSidebarState,
  toolCallId: string,
): ConversationSidebarState {
  return {
    ...state,
    expanded: true,
    activeTab: "tools",
    selectedToolCallId: toolCallId,
    revealMissed: false,
  };
}

function showRun(state: ConversationSidebarState, runId: string): ConversationSidebarState {
  return { ...state, expanded: true, activeTab: "runs", selectedRunId: runId, revealMissed: false };
}

/**
 * State behind the chat's context panel. A file shows in the Files tab over its list; closing it
 * goes back where it was opened from (`SidebarOrigin`). A tool call opens on its line of the Tools
 * list, one at a time, from the list itself, the summary, or a reveal that missed; a run opens on
 * its line of the Runs list the same way, from the thread's run card too; folding either leaves
 * its list as it is. Choosing a tab shows that tab's own content.
 *
 * Opening the panel always shows its tabs: a file is shown by a "show-file",
 * never restored. Collapsing keeps it, so it stays drawn while the panel slides
 * out, and the next opening drops it.
 *
 * "See in the thread" may close the panel first (the phone's sheet covers the thread): when the
 * card is not there, the panel opens again on its list, the call or the run open, saying so.
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
    case "show-tool-call":
      return showToolCall(state, action.toolCallId);
    case "close-tool-call":
      return { ...state, selectedToolCallId: null, revealMissed: false };
    case "show-run":
      return showRun(state, action.runId);
    case "close-run":
      return { ...state, selectedRunId: null, revealMissed: false };
    case "revealed": {
      if (action.found) return { ...state, revealMissed: false };
      const { kind, id } = action.target;
      return {
        ...(kind === "run" ? showRun(state, id) : showToolCall(state, id)),
        revealMissed: true,
      };
    }
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

/** The call the Tools list holds open, null while another tab shows or every line is folded. */
export function openToolCallId(state: ConversationSidebarState): string | null {
  return state.activeTab === "tools" ? state.selectedToolCallId : null;
}

/** The run the Runs list holds open, null while another tab shows or every line is folded. */
export function openRunId(state: ConversationSidebarState): string | null {
  return state.activeTab === "runs" ? state.selectedRunId : null;
}

/** Whether "See in the thread" missed the card of the call or the run its list holds open. */
export function revealMissed(state: ConversationSidebarState): boolean {
  return (openToolCallId(state) ?? openRunId(state)) !== null && state.revealMissed;
}

/**
 * The object URL of the picked file the panel holds, revoked once it holds another or none. A
 * collapsed panel still holds it: it stays drawn while the panel slides out.
 */
export function heldLocalUrl(state: ConversationSidebarState): string | null {
  return state.selectedFile && "local" in state.selectedFile ? state.selectedFile.url : null;
}
