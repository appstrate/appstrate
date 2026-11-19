// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  ASSISTANT_MESSAGE_CLASS,
  COMPOSER_INPUT_CLASS,
  DISCLAIMER_CLASS,
  MARKDOWN_PROSE_CLASS,
  SEARCH_INPUT_CLASS,
  THREAD_FOOTER_CLASS,
  THREAD_VIEWPORT_CLASS,
  USER_MESSAGE_CLASS,
} from "../src/ui/phone-text.ts";

it("keeps the composer and search at 1rem in both orientations", () => {
  for (const classes of [COMPOSER_INPUT_CLASS, SEARCH_INPUT_CLASS]) {
    expect(classes.split(" ")).toContain("text-base");
    expect(classes).not.toMatch(/(?:^|[ :])text-(?:xs|sm)\b/);
  }
  // The shared Input defaults to md:text-sm.
  expect(SEARCH_INPUT_CLASS.split(" ")).toContain("md:text-base");
});

it("uses denser message bodies from md", () => {
  for (const classes of [USER_MESSAGE_CLASS, ASSISTANT_MESSAGE_CLASS]) {
    expect(classes.split(" ")).toContain("text-base");
    expect(classes.split(" ")).toContain("md:text-sm");
  }
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
