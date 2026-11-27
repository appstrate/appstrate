// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  INITIAL_CONVERSATION_SIDEBAR_STATE,
  conversationSidebarReducer,
  heldLocalUrl,
  openToolCallId,
  revealMissed,
  shownFile,
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

  it("reopens on the tabs, never on the file shown before it collapsed", () => {
    const shown = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
    });
    const collapsed = conversationSidebarReducer(shown, { type: "toggle" });

    expect(conversationSidebarReducer(collapsed, { type: "toggle" })).toMatchObject({
      expanded: true,
      activeTab: "files",
      selectedFile: null,
    });
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
      ...INITIAL_CONVERSATION_SIDEBAR_STATE,
      expanded: false,
      activeTab: "runs",
      selectedFile: file("file_a"),
      showLookups: true,
    };

    expect(conversationSidebarReducer(state, { type: "conversation-change" })).toEqual({
      ...state,
      selectedFile: null,
    });
  });

  it("closes a file opened from the list back to the list, and one from the thread closes the panel", () => {
    const fromList = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
      from: "list",
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

  it("closes a file opened from the summary back to the summary", () => {
    const fromSummary = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
      from: "summary",
    });
    expect(shownFile(fromSummary)).toEqual(file("file_a"));
    expect(conversationSidebarReducer(fromSummary, { type: "close-file" })).toMatchObject({
      expanded: true,
      activeTab: "summary",
      selectedFile: null,
    });
  });

  it("holds a picked file's object URL while it shows, collapsed included, and lets go after", () => {
    const picked = {
      local: new File(["# hi"], "notes.md", { type: "text/markdown" }),
      url: "blob:x",
    };
    const shown = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: picked,
    });
    expect(shown).toMatchObject({ expanded: true, activeTab: "files", selectedFile: picked });
    expect(heldLocalUrl(shown)).toBe("blob:x");

    // Still drawn while the panel slides out.
    const collapsed = conversationSidebarReducer(shown, { type: "toggle" });
    expect(heldLocalUrl(collapsed)).toBe("blob:x");
    expect(heldLocalUrl(conversationSidebarReducer(collapsed, { type: "toggle" }))).toBeNull();

    expect(heldLocalUrl(conversationSidebarReducer(shown, { type: "close-file" }))).toBeNull();
    const replaced = conversationSidebarReducer(shown, { type: "show-file", file: file("file_a") });
    expect(heldLocalUrl(replaced)).toBeNull();
  });

  it("shows a file only over the Files tab", () => {
    const withFile = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-file",
      file: file("file_a"),
    });
    expect(shownFile(withFile)).toEqual(file("file_a"));
    expect(shownFile({ ...withFile, activeTab: "summary" })).toBeNull();
    expect(shownFile(conversationSidebarReducer(withFile, { type: "close-file" }))).toBeNull();
  });
});

describe("conversation sidebar tool calls", () => {
  it("opens a call on its line of the Tools tab and folds it back, the list staying", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-tool-call",
      toolCallId: "call_1",
    });
    expect(open).toMatchObject({ expanded: true, activeTab: "tools" });
    expect(openToolCallId(open)).toBe("call_1");

    const folded = conversationSidebarReducer(open, { type: "close-tool-call" });
    expect(folded).toMatchObject({ expanded: true, activeTab: "tools" });
    expect(openToolCallId(folded)).toBeNull();
  });

  it("opens a call from the summary expanded in the Tools list, one call at a time", () => {
    const onSummary = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "select-tab",
      tab: "summary",
    });
    const fromSummary = conversationSidebarReducer(onSummary, {
      type: "show-tool-call",
      toolCallId: "call_1",
    });
    expect(fromSummary).toMatchObject({ expanded: true, activeTab: "tools" });
    expect(openToolCallId(fromSummary)).toBe("call_1");

    // Folding it stays on the list it opened on.
    expect(conversationSidebarReducer(fromSummary, { type: "close-tool-call" }).activeTab).toBe(
      "tools",
    );

    // Opening another folds the first.
    const other = conversationSidebarReducer(fromSummary, {
      type: "show-tool-call",
      toolCallId: "call_2",
    });
    expect(openToolCallId(other)).toBe("call_2");
  });

  it("holds the open call only while the Tools tab shows", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-tool-call",
      toolCallId: "call_1",
    });
    expect(openToolCallId({ ...open, activeTab: "summary" })).toBeNull();
  });

  it("keeps the lookups' switch through an open call, a tab choice and a reopening", () => {
    const shown = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-lookups",
      show: true,
    });
    expect(shown.showLookups).toBe(true);
    const open = conversationSidebarReducer(shown, {
      type: "show-tool-call",
      toolCallId: "call_1",
    });
    const folded = conversationSidebarReducer(open, { type: "close-tool-call" });
    expect(folded.showLookups).toBe(true);
    const elsewhere = conversationSidebarReducer(folded, { type: "select-tab", tab: "summary" });
    const reopened = conversationSidebarReducer(
      conversationSidebarReducer(elsewhere, { type: "toggle" }),
      { type: "toggle" },
    );
    expect(reopened.showLookups).toBe(true);
    expect(
      conversationSidebarReducer(reopened, { type: "show-lookups", show: false }).showLookups,
    ).toBe(false);
  });

  it("folds the open call on a tab choice, a reopening and a conversation change", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-tool-call",
      toolCallId: "call_1",
    });
    const tab = conversationSidebarReducer(open, { type: "select-tab", tab: "tools" });
    expect(openToolCallId(tab)).toBeNull();

    const closed = conversationSidebarReducer(open, { type: "toggle" });
    expect(openToolCallId(closed)).toBe("call_1");
    expect(openToolCallId(conversationSidebarReducer(closed, { type: "toggle" }))).toBeNull();

    const changed = conversationSidebarReducer(open, { type: "conversation-change" });
    expect(openToolCallId(changed)).toBeNull();
  });

  it("leaves the panel as it is when the thread holds the call's card", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-tool-call",
      toolCallId: "call_1",
    });
    // The phone's sheet closed to show the card, and the card was there.
    const closed = conversationSidebarReducer(open, { type: "toggle" });
    const found = conversationSidebarReducer(closed, {
      type: "revealed",
      toolCallId: "call_1",
      found: true,
    });
    expect(found.expanded).toBe(false);
    expect(revealMissed(found)).toBe(false);
  });

  it("opens again on the Tools list, the call open and saying so, when the thread does not hold its card", () => {
    const open = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-tool-call",
      toolCallId: "call_1",
    });
    const closed = conversationSidebarReducer(open, { type: "toggle" });
    const missed = conversationSidebarReducer(closed, {
      type: "revealed",
      toolCallId: "call_1",
      found: false,
    });
    expect(missed).toMatchObject({ expanded: true, activeTab: "tools" });
    expect(openToolCallId(missed)).toBe("call_1");
    expect(revealMissed(missed)).toBe(true);

    // Another call, or the call folded, no longer carry the miss.
    const other = conversationSidebarReducer(missed, {
      type: "show-tool-call",
      toolCallId: "call_2",
    });
    expect(revealMissed(other)).toBe(false);
    expect(revealMissed(conversationSidebarReducer(missed, { type: "close-tool-call" }))).toBe(
      false,
    );
  });
});
