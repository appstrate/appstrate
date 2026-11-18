// SPDX-License-Identifier: Apache-2.0

/**
 * A phone has no hover and a thumb is wider than a pointer: no chat control is smaller than 40 px
 * below md (or carries a 36 px touch area), and nothing is revealed by hover only.
 */

import { describe, expect, it } from "bun:test";
import {
  ACTION_BAR_CLASS,
  ACTION_ROW_CLASS,
  COMPOSER_BUTTON_CLASS,
  COMPOSER_TOOL_BUTTON_CLASS,
  ICON_BUTTON_CLASS,
  QUEUE_ICON_BUTTON_CLASS,
  TOUCH_AREA_CLASS,
} from "../src/ui/touch-targets.ts";

const tokens = (classes: string) => classes.split(/\s+/);

describe.each([
  ["composer button", COMPOSER_BUTTON_CLASS],
  ["composer tool button", COMPOSER_TOOL_BUTTON_CLASS],
  ["message icon button", ICON_BUTTON_CLASS],
  ["queue icon button", QUEUE_ICON_BUTTON_CLASS],
])("%s", (_name, classes) => {
  it("is 40 px below md", () => {
    expect(tokens(classes)).toContain("max-md:size-10");
  });
});

describe("the copy action", () => {
  it("is visible on a phone: only md and up hides it behind hover", () => {
    const list = tokens(ACTION_BAR_CLASS);
    expect(list).not.toContain("opacity-0");
    expect(list).toContain("md:opacity-0");
    expect(list).toContain("md:group-hover:opacity-100");
    expect(list).toContain("md:focus-within:opacity-100");
  });

  it("sits in a row tall enough for the 40 px button", () => {
    expect(tokens(ACTION_ROW_CLASS)).toContain("max-md:h-10");
  });
});

describe("a small control's touch area", () => {
  it("is an invisible overlay, below md only", () => {
    const list = tokens(TOUCH_AREA_CLASS);
    expect(list).toContain("relative");
    expect(list).toContain("max-md:before:absolute");
    expect(list).toContain("max-md:before:-inset-2.5");
  });
});
