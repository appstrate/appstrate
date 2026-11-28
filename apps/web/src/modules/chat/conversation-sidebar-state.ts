// SPDX-License-Identifier: Apache-2.0

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
 * (closing the file closes the panel), the tab's list, or the summary.
 */
export type SidebarOrigin = "thread" | "list" | "summary";

export interface ConversationSidebarState {
  expanded: boolean;
  activeTab: ConversationSidebarTab;
  /** The file shown over the Files tab, null when the tab shows its list. */
  selectedFile: SidebarFile | null;
  fileFrom: SidebarOrigin;
  /** The call the Tools list holds open, null when every line is folded. */
  selectedToolCallId: string | null;
  /** "See in the thread" looked for the open call's card and did not find it. */
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
  | { type: "revealed"; toolCallId: string; found: boolean }
  | { type: "show-lookups"; show: boolean }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "summary",
  selectedFile: null,
  fileFrom: "thread",
  selectedToolCallId: null,
  revealMissed: false,
  showLookups: false,
};

/**
 * State behind the chat's context panel. A file shows in the Files tab over its list; closing it
 * goes back where it was opened from (`SidebarOrigin`). A tool call opens on its line of the Tools
 * list, one at a time, from the list itself, the summary, or a reveal that missed; folding it
 * leaves the list as it is. Choosing a tab shows that tab's own content.
 *
 * Opening the panel always shows its tabs: a file is shown by a "show-file",
 * never restored. Collapsing keeps it, so it stays drawn while the panel slides
 * out, and the next opening drops it.
 *
 * "See in the thread" may close the panel first (the phone's sheet covers the thread): when the
 * card is not there, the panel opens again on the Tools list, the call open, saying so.
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
        revealMissed: false,
      };
    case "close-tool-call":
      return { ...state, selectedToolCallId: null, revealMissed: false };
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

/** The call the Tools list holds open, null while another tab shows or every line is folded. */
export function openToolCallId(state: ConversationSidebarState): string | null {
  return state.activeTab === "tools" ? state.selectedToolCallId : null;
}

/** Whether "See in the thread" missed the card of the call the Tools list holds open. */
export function revealMissed(state: ConversationSidebarState): boolean {
  return openToolCallId(state) !== null && state.revealMissed;
}

/**
 * The object URL of the picked file the panel holds, revoked once it holds another or none. A
 * collapsed panel still holds it: it stays drawn while the panel slides out.
 */
export function heldLocalUrl(state: ConversationSidebarState): string | null {
  return state.selectedFile && "local" in state.selectedFile ? state.selectedFile.url : null;
}
