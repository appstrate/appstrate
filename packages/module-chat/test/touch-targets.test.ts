// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  ACTION_BAR_CLASS,
  ACTION_ROW_CLASS,
  COMPOSER_BUTTON_CLASS,
  COMPOSER_TOOL_BUTTON_CLASS,
  ICON_BUTTON_CLASS,
  QUEUE_ICON_BUTTON_CLASS,
  CHIP_REMOVE_CLASS,
  USER_ACTION_BAR_CLASS,
} from "../src/ui/touch-targets.ts";

const tokens = (classes: string) => classes.split(/\s+/);

describe.each([
  ["composer button", COMPOSER_BUTTON_CLASS],
  ["composer tool button", COMPOSER_TOOL_BUTTON_CLASS],
  ["message icon button", ICON_BUTTON_CLASS],
  ["queue icon button", QUEUE_ICON_BUTTON_CLASS],
  ["chip remove button", CHIP_REMOVE_CLASS],
])("%s", (_name, classes) => {
  it("reserves 40 px for touch", () => {
    expect(tokens(classes)).toContain("size-10");
  });
});

describe("the copy action", () => {
  it("is visible on touch and when focused on desktop", () => {
    const list = tokens(ACTION_BAR_CLASS);
    expect(list).not.toContain("opacity-0");
    expect(list).toContain("desktop-pointer:opacity-0");
    expect(list).toContain("desktop-pointer:group-hover:opacity-100");
    expect(list).toContain("desktop-pointer:focus-within:opacity-100");
  });

  it("sits in a row tall enough for the 40 px button", () => {
    expect(tokens(ACTION_ROW_CLASS)).toContain("h-10");
  });

  it("is under the user's own message too, on touch screens only, in a 40 px row", () => {
    const list = tokens(USER_ACTION_BAR_CLASS);
    expect(list).toContain("h-10");
    expect(list).toContain("desktop-pointer:hidden");
    expect(list).not.toContain("opacity-0");
  });
});
