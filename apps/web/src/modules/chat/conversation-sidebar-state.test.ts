// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  INITIAL_CONVERSATION_SIDEBAR_STATE,
  conversationSidebarReducer,
  type ConversationSidebarState,
} from "./conversation-sidebar-state";

const doc = (id: string) => ({ id, name: `${id}.md` });

describe("conversation sidebar state", () => {
  it("shows every document through the same preview action", () => {
    const first = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-document",
      document: doc("doc_a"),
    });
    const second = conversationSidebarReducer(first, {
      type: "show-document",
      document: doc("doc_b"),
    });

    expect(second).toMatchObject({
      expanded: true,
      activeTab: "preview",
      selectedDocument: doc("doc_b"),
    });
  });

  it("collapses without discarding the selected document", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-document",
      document: doc("doc_a"),
    });
    const collapsed = conversationSidebarReducer(open, { type: "toggle" });

    expect(collapsed.expanded).toBe(false);
    expect(collapsed.selectedDocument).toEqual(doc("doc_a"));
  });

  it("opens the modal only as an explicit second action", () => {
    const selected = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-document",
      document: doc("doc_a"),
    });
    expect(selected.modalDocument).toBeNull();

    const modal = conversationSidebarReducer(selected, { type: "open-modal" });
    expect(modal.modalDocument).toEqual(doc("doc_a"));
  });

  it("clears document state on navigation but keeps the user's panel layout", () => {
    const state: ConversationSidebarState = {
      expanded: false,
      activeTab: "runs",
      selectedDocument: doc("doc_a"),
      modalDocument: doc("doc_a"),
    };

    expect(conversationSidebarReducer(state, { type: "conversation-change" })).toEqual({
      expanded: false,
      activeTab: "runs",
      selectedDocument: null,
      modalDocument: null,
    });
  });
});
