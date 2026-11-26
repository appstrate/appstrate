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
 * Where a detail shown over its tab (a file, a tool call) was opened from, so closing it goes back
 * there: the thread (closing the detail closes the panel), its tab's list, or the summary.
 */
export type SidebarOrigin = "thread" | "list" | "summary";

export interface ConversationSidebarState {
  expanded: boolean;
  activeTab: ConversationSidebarTab;
  /** The file shown over the Files tab, null when the tab shows its list. */
  selectedFile: SidebarFile | null;
  /** Where the shown file was opened from. */
  fileFrom: SidebarOrigin;
  /** The tool call shown over the Tools tab, null when the tab shows its list. */
  selectedToolCallId: string | null;
  /** Where the shown tool call was opened from: its list or the summary. */
  toolCallFrom: Exclude<SidebarOrigin, "thread">;
  /** "See in the thread" looked for the shown call's card and did not find it. */
  revealMissed: boolean;
  /** The Tools tab lists the lookups beside the actions. */
  showLookups: boolean;
}

export type ConversationSidebarAction =
  | { type: "toggle" }
  | { type: "select-tab"; tab: ConversationSidebarTab }
  | { type: "show-file"; file: SidebarFile; from?: SidebarOrigin }
  | { type: "close-file" }
  | { type: "show-tool-call"; toolCallId: string; from?: Exclude<SidebarOrigin, "thread"> }
  | { type: "close-tool-call" }
  /** What "See in the thread" found: missed, the panel opens again on the call to say so. */
  | { type: "revealed"; toolCallId: string; found: boolean }
  | { type: "show-lookups"; show: boolean }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "summary",
  selectedFile: null,
  fileFrom: "thread",
  selectedToolCallId: null,
  toolCallFrom: "list",
  revealMissed: false,
  showLookups: false,
};

/**
 * State behind the chat's context panel. A file shows in the Files tab over its list, a tool call
 * in the Tools tab over its list. Closing either goes back where it was opened from: the thread
 * (a file: the panel closes), its tab's list, or the summary. Choosing a tab shows that tab's own
 * content. Whether the Tools tab lists the lookups is the reader's, kept until they change it.
 *
 * Opening the panel always shows its tabs: a file is shown by a "show-file",
 * never restored. Collapsing keeps it, so it stays drawn while the panel slides
 * out, and the next opening drops it.
 *
 * "See in the thread" may close the panel first (the phone's sheet covers the thread): when the
 * card is not there, the panel opens again on the call, which says so.
 */
export function conversationSidebarReducer(
  state: ConversationSidebarState,
  action: ConversationSidebarAction,
): ConversationSidebarState {
  switch (action.type) {
    case "toggle":
      return state.expanded
        ? { ...state, expanded: false }
        : {
            ...state,
            expanded: true,
            selectedFile: null,
            selectedToolCallId: null,
            revealMissed: false,
          };
    case "select-tab":
      return {
        ...state,
        expanded: true,
        activeTab: action.tab,
        selectedFile: null,
        selectedToolCallId: null,
        revealMissed: false,
      };
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
        ...(state.fileFrom === "summary" ? { activeTab: "summary" as const } : {}),
      };
    case "show-tool-call":
      return {
        ...state,
        expanded: true,
        activeTab: "tools",
        selectedToolCallId: action.toolCallId,
        toolCallFrom: action.from ?? "list",
        revealMissed: false,
      };
    case "close-tool-call":
      return {
        ...state,
        activeTab: state.toolCallFrom === "summary" ? "summary" : "tools",
        selectedToolCallId: null,
        revealMissed: false,
      };
    case "revealed":
      return action.found
        ? { ...state, revealMissed: false }
        : {
            ...state,
            expanded: true,
            activeTab: "tools",
            selectedToolCallId: action.toolCallId,
            revealMissed: true,
          };
    case "show-lookups":
      return { ...state, showLookups: action.show };
    case "conversation-change":
      return { ...state, selectedFile: null, selectedToolCallId: null, revealMissed: false };
  }
}

/** The file the panel shows over the Files tab, null while it shows a tab's content. */
export function shownFile(state: ConversationSidebarState): SidebarFile | null {
  return state.activeTab === "files" ? state.selectedFile : null;
}

/** The tool call the panel shows over the Tools tab, null while it shows a tab's content. */
export function shownToolCallId(state: ConversationSidebarState): string | null {
  return state.activeTab === "tools" ? state.selectedToolCallId : null;
}

/** Whether "See in the thread" missed the card of the call the panel shows. */
export function revealMissed(state: ConversationSidebarState): boolean {
  return shownToolCallId(state) !== null && state.revealMissed;
}

/**
 * The object URL of the picked file the panel holds, revoked once it holds another or none. A
 * collapsed panel still holds it: it stays drawn while the panel slides out.
 */
export function heldLocalUrl(state: ConversationSidebarState): string | null {
  return state.selectedFile && "local" in state.selectedFile ? state.selectedFile.url : null;
}
