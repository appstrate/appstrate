// SPDX-License-Identifier: Apache-2.0

/**
 * iOS Safari zooms the page when a field with a font under 16 px takes focus. A text-entry class
 * of the chat is therefore 16 px (`text-base`) with no phone-size override: the dense size only
 * comes in behind a breakpoint prefix.
 */

import { describe, expect, it } from "bun:test";
import {
  ASSISTANT_MESSAGE_CLASS,
  COMPOSER_INPUT_CLASS,
  DISCLAIMER_CLASS,
  MARKDOWN_PROSE_CLASS,
  NOTE_TEXT_CLASS,
  READING_TEXT_CLASS,
  READING_TEXT_DENSE_CLASS,
  SEARCH_INPUT_CLASS,
  THREAD_FOOTER_CLASS,
  THREAD_VIEWPORT_CLASS,
  USER_MESSAGE_CLASS,
} from "../src/ui/phone-text.ts";

const DENSE = /^(text-(xs|sm)|text-\[[^\]]+\])$/;

/** The size tokens that apply with no breakpoint prefix (what a phone gets). */
function phoneSizes(classes: string): string[] {
  return classes.split(/\s+/).filter((token) => token.startsWith("text-") && !token.includes(":"));
}

describe.each([
  ["composer input", COMPOSER_INPUT_CLASS],
  ["conversation search", SEARCH_INPUT_CLASS],
  ["user message", USER_MESSAGE_CLASS],
  ["assistant message", ASSISTANT_MESSAGE_CLASS],
  ["reading text", READING_TEXT_CLASS],
  ["dense reading text", READING_TEXT_DENSE_CLASS],
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

describe("markdown prose", () => {
  it("is the base prose size on a phone and the small one from md", () => {
    const tokens = MARKDOWN_PROSE_CLASS.split(/\s+/);
    expect(tokens).toContain("prose-base");
    expect(tokens).toContain("md:prose-sm");
    expect(tokens).not.toContain("prose-sm");
  });

  it("keeps code blocks at 14 px on a phone and 12 px from md", () => {
    expect(MARKDOWN_PROSE_CLASS).toContain("[&_pre]:text-sm");
    expect(MARKDOWN_PROSE_CLASS).toContain("md:[&_pre]:text-xs");
  });
});

describe("thread layout on a phone", () => {
  it("the transcript keeps its scroll to itself", () => {
    expect(THREAD_VIEWPORT_CLASS.split(/\s+/)).toContain("overscroll-contain");
  });

  it("the disclaimer steps aside while the composer has the focus, below md only", () => {
    expect(THREAD_FOOTER_CLASS.split(/\s+/)).toContain("group/footer");
    expect(DISCLAIMER_CLASS.split(/\s+/)).toContain("max-md:group-focus-within/footer:hidden");
  });
});

describe("secondary text", () => {
  it("is 14 px on a phone, never the 12 px of the dense size", () => {
    expect(phoneSizes(NOTE_TEXT_CLASS)).toEqual(["text-sm"]);
    expect(NOTE_TEXT_CLASS.split(/\s+/)).toContain("md:text-xs");
  });
});
