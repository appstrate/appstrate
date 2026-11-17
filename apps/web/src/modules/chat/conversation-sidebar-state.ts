// SPDX-License-Identifier: Apache-2.0

export type ConversationSidebarTab = "runs" | "files" | "info";

export interface SidebarFile {
  id: string;
  name: string;
  /** The file's space when it is not the working one (a conversation's file elsewhere). */
  spaceId?: string;
}

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
