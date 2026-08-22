// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  INITIAL_CONVERSATION_SIDEBAR_STATE,
  conversationSidebarReducer,
  type ConversationSidebarState,
} from "./conversation-sidebar-state";

const file = (id: string) => ({ id, name: `${id}.md` });

describe("conversation sidebar state", () => {
  it("starts collapsed until context is explicitly requested", () => {
    expect(INITIAL_CONVERSATION_SIDEBAR_STATE.expanded).toBe(false);
  });

  it("shows every file through the same preview action", () => {
    const first = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("doc_a"),
    });
    const second = conversationSidebarReducer(first, {
      type: "show-file",
      file: file("doc_b"),
    });

    expect(second).toMatchObject({
      expanded: true,
      activeTab: "preview",
      selectedFile: file("doc_b"),
    });
  });

  it("collapses without discarding the selected file", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("doc_a"),
    });
    const collapsed = conversationSidebarReducer(open, { type: "toggle" });

    expect(collapsed.expanded).toBe(false);
    expect(collapsed.selectedFile).toEqual(file("doc_a"));
  });

  it("reopens the panel when a header tab is selected", () => {
    const collapsed: ConversationSidebarState = {
      ...INITIAL_CONVERSATION_SIDEBAR_STATE,
      expanded: false,
      activeTab: "preview",
    };

    expect(
      conversationSidebarReducer(collapsed, { type: "select-tab", tab: "preview" }),
    ).toMatchObject({
      expanded: true,
      activeTab: "preview",
    });
  });

  it("opens the modal only as an explicit second action", () => {
    const selected = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("doc_a"),
    });
    expect(selected.modalFile).toBeNull();

    const modal = conversationSidebarReducer(selected, { type: "open-modal" });
    expect(modal.modalFile).toEqual(file("doc_a"));
  });

  it("clears file state on navigation but keeps the user's panel layout", () => {
    const state: ConversationSidebarState = {
      expanded: false,
      activeTab: "runs",
      selectedFile: file("doc_a"),
      modalFile: file("doc_a"),
    };

    expect(conversationSidebarReducer(state, { type: "conversation-change" })).toEqual({
      expanded: false,
      activeTab: "runs",
      selectedFile: null,
      modalFile: null,
    });
  });
});
