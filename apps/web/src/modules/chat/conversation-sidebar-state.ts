// SPDX-License-Identifier: Apache-2.0

export type ConversationSidebarTab = "runs" | "files" | "info";

export interface SidebarFile {
  id: string;
  name: string;
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
 * State behind the chat's one context surface. A file is always shown in the
 * Files tab, over its list. Opened from the thread (a click on a run's file, or
 * the single file a run just produced), closing it closes the panel; opened from
 * the list, closing it goes back to the list. Choosing a tab shows that tab's
 * own content, so the Files tab shows its list again.
 */
export function conversationSidebarReducer(
  state: ConversationSidebarState,
  action: ConversationSidebarAction,
): ConversationSidebarState {
  switch (action.type) {
    case "toggle":
      return { ...state, expanded: !state.expanded };
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
