// SPDX-License-Identifier: Apache-2.0

/**
 * The chat sidebar's width, as stored per browser: a width outside its bounds is brought back
 * inside them, and anything unreadable falls back to the default (null).
 */

import { describe, expect, it } from "bun:test";
import { CHAT_SIDEBAR_WIDTH, clampChatSidebarWidth, parseChatSidebarWidth } from "../sidebar-store";

describe("the chat sidebar's width", () => {
  it("stays between its floor and its ceiling", () => {
    expect(clampChatSidebarWidth(100)).toBe(CHAT_SIDEBAR_WIDTH.min);
    expect(clampChatSidebarWidth(320)).toBe(320);
    expect(clampChatSidebarWidth(2000)).toBe(CHAT_SIDEBAR_WIDTH.max);
  });

  it("reads a stored width back, clamped", () => {
    expect(parseChatSidebarWidth("320")).toBe(320);
    expect(parseChatSidebarWidth("9999")).toBe(CHAT_SIDEBAR_WIDTH.max);
  });

  it("falls back to the default when nothing usable is stored", () => {
    expect(parseChatSidebarWidth(null)).toBeNull();
    expect(parseChatSidebarWidth("")).toBeNull();
    expect(parseChatSidebarWidth("wide")).toBeNull();
    expect(parseChatSidebarWidth("-5")).toBeNull();
  });
});
