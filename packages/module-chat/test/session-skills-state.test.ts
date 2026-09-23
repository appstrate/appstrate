// SPDX-License-Identifier: Apache-2.0

/** The pure half of the skill picker: the pin toggle and its rows. */

import { describe, expect, it } from "bun:test";
import { skillPickerRows, togglePinned } from "../src/ui/chat-skills.ts";
import { MAX_PINNED_SKILLS } from "../src/skills.ts";

const fullSet = () => Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@s/p${i}`).sort();

describe("togglePinned", () => {
  it("adds, removes, and keeps the set sorted", () => {
    expect(togglePinned(["@b/x"], "@a/y")).toEqual(["@a/y", "@b/x"]);
    expect(togglePinned(["@a/y", "@b/x"], "@a/y")).toEqual(["@b/x"]);
  });

  it("still unpins when the set is full", () => {
    const full = fullSet();
    expect(togglePinned(full, full[0]!)).toHaveLength(MAX_PINNED_SKILLS - 1);
  });
});

describe("skillPickerRows", () => {
  const tone = {
    package_id: "@acme/tone",
    display_name: "Tone",
    description: null,
    version: "1.0.0",
  };

  it("lists the catalogue as available rows, in its order", () => {
    const pdf = { ...tone, package_id: "@acme/pdf" };
    expect(skillPickerRows([tone, pdf], ["@acme/pdf"])).toEqual([
      { skill: tone, available: true },
      { skill: pdf, available: true },
    ]);
  });

  it("appends every pin the catalogue no longer lists, so it can be unpinned", () => {
    expect(skillPickerRows([tone], ["@acme/gone", "@acme/tone", "@z/deleted"])).toEqual([
      { skill: tone, available: true },
      { skill: { package_id: "@acme/gone" }, available: false },
      { skill: { package_id: "@z/deleted" }, available: false },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      { skill: { package_id: "@acme/gone" }, available: false },
    ]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});
