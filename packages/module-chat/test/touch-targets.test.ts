// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { buttonVariants } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import {
  ACTION_BAR_CLASS,
  ACTION_ROW_CLASS,
  COMPOSER_BUTTON_CLASS,
  ICON_BUTTON_CLASS,
  CHIP_REMOVE_CLASS,
  USER_ACTION_BAR_CLASS,
} from "../src/ui/touch-targets.ts";

const tokens = (classes: string) => classes.split(/\s+/);
/** What an icon `Button` renders with `size="icon-sm"` and these classes. */
const iconSm = (classes: string) => tokens(cn(buttonVariants({ size: "icon-sm" }), classes));

describe.each([
  ["composer button", iconSm(COMPOSER_BUTTON_CLASS)],
  ["composer tool button", iconSm(cn(COMPOSER_BUTTON_CLASS, "text-muted-foreground"))],
  ["message icon button", iconSm(ICON_BUTTON_CLASS)],
  ["queue icon button", iconSm(cn(ICON_BUTTON_CLASS, "desktop-pointer:size-6"))],
])("%s", (_name, list) => {
  it("is 44 px on touch", () => {
    expect(list).toContain("size-11");
  });
});

describe("chip remove button", () => {
  it("reserves 40 px for touch", () => {
    expect(tokens(CHIP_REMOVE_CLASS)).toContain("size-10");
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

  it("sits in a row tall enough for the 44 px button", () => {
    expect(tokens(ACTION_ROW_CLASS)).toContain("h-11");
  });

  it("is under the user's own message too, revealed by hover under a mouse, in a 44 px row", () => {
    const list = tokens(USER_ACTION_BAR_CLASS);
    expect(list).toContain("h-11");
    expect(list).not.toContain("desktop-pointer:hidden");
    expect(list).toContain("desktop-pointer:opacity-0");
    expect(list).toContain("desktop-pointer:group-hover:opacity-100");
    expect(list).toContain("desktop-pointer:focus-within:opacity-100");
  });
});
