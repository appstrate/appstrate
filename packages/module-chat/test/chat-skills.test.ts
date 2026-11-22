// SPDX-License-Identifier: Apache-2.0

/** The skill picker's pure rules. */

import { describe, expect, it } from "bun:test";
import { skillPickerRows, togglePinned } from "../src/ui/chat-skills.ts";

describe("togglePinned", () => {
  it("adds and removes", () => {
    expect(togglePinned(["@b/x"], "@a/y")).toEqual(["@b/x", "@a/y"]);
    expect(togglePinned(["@a/y", "@b/x"], "@a/y")).toEqual(["@b/x"]);
  });
});

describe("skillPickerRows", () => {
  const tone = { id: "@acme/tone", name: "Tone", description: "", version: "1.0.0" };

  it("lists the catalogue as available rows, in its order", () => {
    const pdf = { ...tone, id: "@acme/pdf" };
    expect(skillPickerRows([tone, pdf], ["@acme/pdf"])).toEqual([
      { skill: tone, available: true },
      { skill: pdf, available: true },
    ]);
  });

  it("appends every pin the catalogue no longer lists, so it can be unpinned", () => {
    expect(skillPickerRows([tone], ["@acme/gone", "@acme/tone", "@z/deleted"])).toEqual([
      { skill: tone, available: true },
      {
        skill: { id: "@acme/gone", name: "gone", description: "", version: null },
        available: false,
      },
      {
        skill: { id: "@z/deleted", name: "deleted", description: "", version: null },
        available: false,
      },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      {
        skill: { id: "@acme/gone", name: "gone", description: "", version: null },
        available: false,
      },
    ]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});
