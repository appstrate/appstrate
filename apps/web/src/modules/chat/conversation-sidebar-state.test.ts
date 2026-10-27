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

  it("shows every file in the Files tab", () => {
    const first = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
    });
    const second = conversationSidebarReducer(first, {
      type: "show-file",
      file: file("file_b"),
    });

    expect(second).toMatchObject({
      expanded: true,
      activeTab: "files",
      selectedFile: file("file_b"),
    });
  });

  it("collapses without discarding the selected file", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
    });
    const collapsed = conversationSidebarReducer(open, { type: "toggle" });

    expect(collapsed.expanded).toBe(false);
    expect(collapsed.selectedFile).toEqual(file("file_a"));
  });

  it("reopens the panel on a header tab, showing that tab's own content", () => {
    const collapsed: ConversationSidebarState = {
      ...INITIAL_CONVERSATION_SIDEBAR_STATE,
      expanded: false,
      selectedFile: file("file_a"),
    };

    expect(
      conversationSidebarReducer(collapsed, { type: "select-tab", tab: "files" }),
    ).toMatchObject({ expanded: true, activeTab: "files", selectedFile: null });
  });

  it("clears the shown file on navigation but keeps the user's panel layout", () => {
    const state: ConversationSidebarState = {
      expanded: false,
      activeTab: "runs",
      selectedFile: file("file_a"),
      fileFromList: false,
    };

    expect(conversationSidebarReducer(state, { type: "conversation-change" })).toEqual({
      expanded: false,
      activeTab: "runs",
      selectedFile: null,
      fileFromList: false,
    });
  });

  it("closes a file opened from the list back to the list, and one from the thread closes the panel", () => {
    const fromList = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
      fromList: true,
    });
    expect(conversationSidebarReducer(fromList, { type: "close-file" })).toMatchObject({
      expanded: true,
      activeTab: "files",
      selectedFile: null,
    });

    const fromThread = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
    });
    expect(conversationSidebarReducer(fromThread, { type: "close-file" })).toMatchObject({
      expanded: false,
    });
  });
});
