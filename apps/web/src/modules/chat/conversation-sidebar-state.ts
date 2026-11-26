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

export interface ConversationSidebarState {
  expanded: boolean;
  activeTab: ConversationSidebarTab;
  /** The file shown over the Files tab, null when the tab shows its list. */
  selectedFile: SidebarFile | null;
  /** The shown file was opened from the list: closing it goes back to the list. */
  fileFromList: boolean;
  /** The tool call shown over the Tools tab, null when the tab shows its list. */
  selectedToolCallId: string | null;
  /** The tool call whose card "See in the thread" last looked for and did not find. */
  missedRevealId: string | null;
}

export type ConversationSidebarAction =
  | { type: "toggle" }
  | { type: "select-tab"; tab: ConversationSidebarTab }
  | { type: "show-file"; file: SidebarFile; fromList?: boolean }
  | { type: "close-file" }
  | { type: "show-tool-call"; toolCallId: string }
  | { type: "close-tool-call" }
  /** What "See in the thread" found: missed, the panel opens again on the call to say so. */
  | { type: "revealed"; toolCallId: string; found: boolean }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "summary",
  selectedFile: null,
  fileFromList: false,
  selectedToolCallId: null,
  missedRevealId: null,
};

/**
 * State behind the chat's context panel. A file shows in the Files tab over its
 * list: closing it closes the panel when opened from the thread, goes back to
 * the list when opened from the list. A tool call shows in the Tools tab over its
 * list, and closing it goes back to the list. Choosing a tab shows that tab's own content.
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
            missedRevealId: null,
          };
    case "select-tab":
      return {
        ...state,
        expanded: true,
        activeTab: action.tab,
        selectedFile: null,
        selectedToolCallId: null,
        missedRevealId: null,
      };
    case "show-file":
      return {
        ...state,
        expanded: true,
        activeTab: "files",
        selectedFile: action.file,
        fileFromList: action.fromList === true,
      };
    case "close-file":
      return state.fileFromList
        ? { ...state, selectedFile: null }
        : { ...state, expanded: false, selectedFile: null };
    case "show-tool-call":
      return {
        ...state,
        expanded: true,
        activeTab: "tools",
        selectedToolCallId: action.toolCallId,
        missedRevealId: null,
      };
    case "close-tool-call":
      return { ...state, selectedToolCallId: null, missedRevealId: null };
    case "revealed":
      return action.found
        ? { ...state, missedRevealId: null }
        : {
            ...state,
            expanded: true,
            activeTab: "tools",
            selectedToolCallId: action.toolCallId,
            missedRevealId: action.toolCallId,
          };
    case "conversation-change":
      return { ...state, selectedFile: null, selectedToolCallId: null, missedRevealId: null };
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
  const shown = shownToolCallId(state);
  return shown !== null && state.missedRevealId === shown;
}

/**
 * The object URL of the picked file the panel holds, revoked once it holds another or none. A
 * collapsed panel still holds it: it stays drawn while the panel slides out.
 */
export function heldLocalUrl(state: ConversationSidebarState): string | null {
  return state.selectedFile && "local" in state.selectedFile ? state.selectedFile.url : null;
}
