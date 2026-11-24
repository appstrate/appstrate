// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  ASSISTANT_MESSAGE_CLASS,
  COMPOSER_INPUT_CLASS,
  COMPOSER_FIELD_CLASS,
  COMPOSER_ROW_CLASS,
  COMPOSER_PLACEHOLDER_CLASS,
  COMPOSER_TOOLS_CLASS,
  DISCLAIMER_CLASS,
  MARKDOWN_PROSE_CLASS,
  NEW_CONVERSATION_CLASS,
  NOTE_TEXT_CLASS,
  READING_TEXT_CLASS,
  READING_TEXT_DENSE_CLASS,
  SEARCH_INPUT_CLASS,
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
  for (const classes of [USER_MESSAGE_CLASS, ASSISTANT_MESSAGE_CLASS, READING_TEXT_CLASS]) {
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

  it('has no disclaimer under the composer on a phone: it is in the "+" panel', () => {
    expect(DISCLAIMER_CLASS.split(/\s+/)).toContain("max-md:hidden");
  });
});

describe("secondary text", () => {
  it("is 14 px on a phone, never the 12 px of the dense size", () => {
    expect(NOTE_TEXT_CLASS.split(" ")).toContain("text-sm");
    expect(READING_TEXT_DENSE_CLASS.split(" ")).toEqual(["text-base", "md:text-xs"]);
    expect(NOTE_TEXT_CLASS.split(/\s+/)).toContain("md:text-xs");
  });
});

describe("composer row", () => {
  it("is one line on a phone, always, and two from md up", () => {
    const row = COMPOSER_ROW_CLASS.split(/\s+/);
    expect(row).not.toContain("flex-wrap");
    expect(row).toContain("md:flex-wrap");
    // The field is the line's stretchy cell on a phone and a line of its own from md.
    expect(COMPOSER_FIELD_CLASS.split(/\s+/)).toContain("max-md:flex-1");
    expect(COMPOSER_FIELD_CLASS.split(/\s+/)).toContain("md:basis-full");
    // Empty, a narrow screen's placeholder is one line, never two.
    expect(COMPOSER_PLACEHOLDER_CLASS.split(/\s+/)).toContain("truncate");
    expect(COMPOSER_INPUT_CLASS.split(/\s+/)).toContain("text-base");
  });

  it('keeps the phone\'s line to the "+", the field and send: the model is in the panel', () => {
    expect(COMPOSER_TOOLS_CLASS.split(/\s+/)).toContain("max-md:flex-none");
  });
});

describe("the sidebar's search and new-conversation row, the same on every format", () => {
  it("shows the search as a filled field with no border, 44 px tall", () => {
    const classes = SEARCH_INPUT_CLASS.split(" ");
    expect(classes).toContain("bg-muted");
    expect(classes).toContain("border-0");
    expect(classes).toContain("h-11");
    expect(SEARCH_INPUT_CLASS).not.toMatch(/(?:^| )(?:max-)?md:(?:h|bg|border|rounded)-/);
  });

  it("aligns the new-conversation row to the left, as the conversations are, 44 px under a mouse too", () => {
    const classes = NEW_CONVERSATION_CLASS.split(" ");
    expect(classes).toContain("justify-start");
    expect(classes).toContain("desktop-pointer:h-11");
    expect(NEW_CONVERSATION_CLASS).not.toContain("md:");
  });
});
