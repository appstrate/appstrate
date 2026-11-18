// SPDX-License-Identifier: Apache-2.0

/**
 * iOS Safari zooms the page when a field with a font under 16 px takes focus. A text-entry class
 * of the chat is therefore 16 px (`text-base`) with no phone-size override: the dense size only
 * comes in behind a breakpoint prefix.
 */

import { describe, expect, it } from "bun:test";
import { COMPOSER_INPUT_CLASS, SEARCH_INPUT_CLASS } from "../src/ui/phone-text.ts";

const DENSE = /^(text-(xs|sm)|text-\[[^\]]+\])$/;

/** The size tokens that apply with no breakpoint prefix (what a phone gets). */
function phoneSizes(classes: string): string[] {
  return classes.split(/\s+/).filter((token) => token.startsWith("text-") && !token.includes(":"));
}

describe.each([
  ["composer input", COMPOSER_INPUT_CLASS],
  ["conversation search", SEARCH_INPUT_CLASS],
])("%s", (_name, classes) => {
  it("is 16 px on a phone", () => {
    const sizes = phoneSizes(classes);
    expect(sizes).toContain("text-base");
    expect(sizes.filter((token) => DENSE.test(token))).toEqual([]);
  });

  it("only goes denser from the md breakpoint", () => {
    const dense = classes.split(/\s+/).filter((token) => /(^|:)text-(xs|sm)$/.test(token));
    for (const token of dense) expect(token.startsWith("md:")).toBe(true);
  });
});
