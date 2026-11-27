// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { KEEP_DRAWER_OPEN, keepsDrawerOpen } from "../drawer-navigation";

describe("keepsDrawerOpen", () => {
  it("keeps the sheet open after a product tab", () => {
    expect(keepsDrawerOpen(KEEP_DRAWER_OPEN)).toBe(true);
  });

  it("folds it after any other navigation", () => {
    for (const state of [null, undefined, "keepDrawerOpen", {}, { keepDrawerOpen: "true" }]) {
      expect({ state, keeps: keepsDrawerOpen(state) }).toEqual({ state, keeps: false });
    }
    // An overlay's background location is router state too, and folds the sheet.
    expect(keepsDrawerOpen({ backgroundLocation: { pathname: "/" } })).toBe(false);
  });
});
