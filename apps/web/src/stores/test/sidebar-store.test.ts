// SPDX-License-Identifier: Apache-2.0

/**
 * The sidebar's width (both products), as stored per browser: a width outside its bounds is brought back
 * inside them, anything unusable falls back to the default (null), and only a commit writes.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

const KEY = "appstrate-sidebar-width";
const storage = installFakeStorage();

const { SIDEBAR_WIDTH, sidebarMaxWidth, sidebarWidthCss, clampSidebarWidth, useSidebarWidthStore } =
  await import("../sidebar-store.ts");
const { parseStoredWidth } = await import("../panel-width-store.ts");
const parse = (value: unknown) => parseStoredWidth(value, (width) => clampSidebarWidth(width));

describe("the sidebar's width", () => {
  afterEach(() => storage.clear());

  it("stays between its floor and its ceiling", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH.min);
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(2000)).toBe(SIDEBAR_WIDTH.max);
  });

  it("caps its ceiling at 30% of a narrow window, never below the default", () => {
    expect(sidebarMaxWidth(1920)).toBe(SIDEBAR_WIDTH.max);
    expect(sidebarMaxWidth(1200)).toBe(360);
    expect(sidebarMaxWidth(800)).toBe(SIDEBAR_WIDTH.default);
    expect(clampSidebarWidth(400, sidebarMaxWidth(1200))).toBe(360);
    expect(clampSidebarWidth(100, sidebarMaxWidth(800))).toBe(SIDEBAR_WIDTH.min);
  });

  it("applies the same cap in CSS, so a stored width follows the window", () => {
    expect(sidebarWidthCss(400)).toBe("min(400px, max(256px, 30vw))");
    expect(sidebarWidthCss(null)).toBe("min(256px, max(256px, 30vw))");
  });

  it("reads a stored width back, clamped", () => {
    expect(parse(320)).toBe(320);
    expect(parse(100)).toBe(SIDEBAR_WIDTH.min);
  });

  it("falls back to the default when nothing usable is stored", () => {
    for (const value of [null, "", "wide", "320", -5, 0, Number.NaN, Infinity, {}]) {
      expect(parse(value)).toBeNull();
    }
  });

  it("follows a drag without writing, then persists the commit", () => {
    const { setLive, commit } = useSidebarWidthStore.getState();
    setLive(300);
    expect(useSidebarWidthStore.getState().width).toBe(300);
    expect(storage.getItem(KEY)).toBeNull();
    commit(300.4);
    expect(useSidebarWidthStore.getState().width).toBe(300);
    expect(storage.getItem(KEY)).toBe("300");
  });

  it("resets to the default on a null commit", () => {
    useSidebarWidthStore.getState().commit(320);
    useSidebarWidthStore.getState().commit(null);
    expect(useSidebarWidthStore.getState().width).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
  });
});
