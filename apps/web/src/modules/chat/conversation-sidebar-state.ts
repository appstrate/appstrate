// SPDX-License-Identifier: Apache-2.0

export type ConversationSidebarTab = "preview" | "runs" | "files" | "info";

export interface SidebarFile {
  id: string;
  name: string;
}

export interface ConversationSidebarState {
  expanded: boolean;
  activeTab: ConversationSidebarTab;
  selectedFile: SidebarFile | null;
}

export type ConversationSidebarAction =
  | { type: "toggle" }
  | { type: "select-tab"; tab: ConversationSidebarTab }
  | { type: "show-file"; file: SidebarFile }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "preview",
  selectedFile: null,
};

/**
 * State behind the chat's one context surface. `show-file` deliberately
 * carries no source: a click and the single file a run just produced are the
 * exact same event once they cross the module boundary.
 */
export function conversationSidebarReducer(
  state: ConversationSidebarState,
  action: ConversationSidebarAction,
): ConversationSidebarState {
  switch (action.type) {
    case "toggle":
      return { ...state, expanded: !state.expanded };
    case "select-tab":
      return { ...state, expanded: true, activeTab: action.tab };
    case "show-file":
      return {
        ...state,
        expanded: true,
        activeTab: "preview",
        selectedFile: action.file,
      };
    case "conversation-change":
      return { ...state, selectedFile: null };
  }
}
