// SPDX-License-Identifier: Apache-2.0

export type ConversationSidebarTab = "preview" | "runs" | "documents" | "info";

export interface SidebarDocument {
  id: string;
  name: string;
}

export interface ConversationSidebarState {
  expanded: boolean;
  activeTab: ConversationSidebarTab;
  selectedDocument: SidebarDocument | null;
  modalDocument: SidebarDocument | null;
}

export type ConversationSidebarAction =
  | { type: "toggle" }
  | { type: "select-tab"; tab: ConversationSidebarTab }
  | { type: "show-document"; document: SidebarDocument }
  | { type: "open-modal" }
  | { type: "close-modal" }
  | { type: "conversation-change" };

export const INITIAL_CONVERSATION_SIDEBAR_STATE: ConversationSidebarState = {
  expanded: false,
  activeTab: "preview",
  selectedDocument: null,
  modalDocument: null,
};

/**
 * State behind the chat's one context surface. `show-document` deliberately
 * carries no source: a click and a newly published primary document are the
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
    case "show-document":
      return {
        ...state,
        expanded: true,
        activeTab: "preview",
        selectedDocument: action.document,
      };
    case "open-modal":
      return state.selectedDocument ? { ...state, modalDocument: state.selectedDocument } : state;
    case "close-modal":
      return state.modalDocument ? { ...state, modalDocument: null } : state;
    case "conversation-change":
      return { ...state, selectedDocument: null, modalDocument: null };
  }
}
