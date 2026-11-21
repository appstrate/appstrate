// SPDX-License-Identifier: Apache-2.0

export type ConversationSidebarTab = "runs" | "files" | "info";

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
}

export type ConversationSidebarAction =
  | { type: "toggle" }
  | { type: "select-tab"; tab: ConversationSidebarTab }
  | { type: "show-file"; file: SidebarFile; fromList?: boolean }
  | { type: "close-file" }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "files",
  selectedFile: null,
  fileFromList: false,
};

/**
 * State behind the chat's context panel. A file shows in the Files tab over its
 * list: closing it closes the panel when opened from the thread, goes back to
 * the list when opened from the list. Choosing a tab shows that tab's own content.
 *
 * Opening the panel always shows its tabs: a file is shown by a "show-file",
 * never restored. Collapsing keeps it, so it stays drawn while the panel slides
 * out, and the next opening drops it.
 */
export function conversationSidebarReducer(
  state: ConversationSidebarState,
  action: ConversationSidebarAction,
): ConversationSidebarState {
  switch (action.type) {
    case "toggle":
      return state.expanded
        ? { ...state, expanded: false }
        : { ...state, expanded: true, selectedFile: null };
    case "select-tab":
      return { ...state, expanded: true, activeTab: action.tab, selectedFile: null };
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
    case "conversation-change":
      return { ...state, selectedFile: null };
  }
}

/** The file the panel shows over the Files tab, null while it shows a tab's content. */
export function shownFile(state: ConversationSidebarState): SidebarFile | null {
  return state.activeTab === "files" ? state.selectedFile : null;
}

/**
 * The object URL of the picked file the panel holds, revoked once it holds another or none. A
 * collapsed panel still holds it: it stays drawn while the panel slides out.
 */
export function heldLocalUrl(state: ConversationSidebarState): string | null {
  return state.selectedFile && "local" in state.selectedFile ? state.selectedFile.url : null;
}
