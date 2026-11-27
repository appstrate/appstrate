// SPDX-License-Identifier: Apache-2.0

/**
 * The chat sidebar's width, as stored per browser: a width outside its bounds is brought back
 * inside them, anything unusable falls back to the default (null), and only a commit writes.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

const KEY = "appstrate-chat-sidebar-width";
const storage = installFakeStorage();

const {
  CHAT_SIDEBAR_WIDTH,
  chatSidebarMaxWidth,
  chatSidebarWidthCss,
  clampChatSidebarWidth,
  parseChatSidebarWidth,
  useChatSidebarWidthStore,
} = await import("../sidebar-store.ts");

describe("the chat sidebar's width", () => {
  afterEach(() => storage.clear());

  it("stays between its floor and its ceiling", () => {
    expect(clampChatSidebarWidth(100)).toBe(CHAT_SIDEBAR_WIDTH.min);
    expect(clampChatSidebarWidth(320)).toBe(320);
    expect(clampChatSidebarWidth(2000)).toBe(CHAT_SIDEBAR_WIDTH.max);
  });

  it("caps its ceiling at 30% of a narrow window, never below the default", () => {
    expect(chatSidebarMaxWidth(1920)).toBe(CHAT_SIDEBAR_WIDTH.max);
    expect(chatSidebarMaxWidth(1200)).toBe(360);
    expect(chatSidebarMaxWidth(800)).toBe(CHAT_SIDEBAR_WIDTH.default);
    expect(clampChatSidebarWidth(400, chatSidebarMaxWidth(1200))).toBe(360);
    expect(clampChatSidebarWidth(100, chatSidebarMaxWidth(800))).toBe(CHAT_SIDEBAR_WIDTH.min);
  });

  it("applies the same cap in CSS, so a stored width follows the window", () => {
    expect(chatSidebarWidthCss(400)).toBe("min(400px, max(256px, 30vw))");
    expect(chatSidebarWidthCss(null)).toBe("min(256px, max(256px, 30vw))");
  });

  it("reads a stored width back, clamped", () => {
    expect(parseChatSidebarWidth(320)).toBe(320);
    expect(parseChatSidebarWidth(100)).toBe(CHAT_SIDEBAR_WIDTH.min);
  });

  it("falls back to the default when nothing usable is stored", () => {
    for (const value of [null, "", "wide", "320", -5, 0, Number.NaN, Infinity, {}]) {
      expect(parseChatSidebarWidth(value)).toBeNull();
    }
  });

  it("follows a drag without writing, then persists the commit", () => {
    const { setLive, commit } = useChatSidebarWidthStore.getState();
    setLive(300);
    expect(useChatSidebarWidthStore.getState().width).toBe(300);
    expect(storage.getItem(KEY)).toBeNull();
    commit(300.4);
    expect(useChatSidebarWidthStore.getState().width).toBe(300);
    expect(storage.getItem(KEY)).toBe("300");
  });

  it("resets to the default on a null commit", () => {
    useChatSidebarWidthStore.getState().commit(320);
    useChatSidebarWidthStore.getState().commit(null);
    expect(useChatSidebarWidthStore.getState().width).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
  });
});
