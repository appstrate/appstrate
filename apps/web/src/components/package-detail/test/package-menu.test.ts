// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { Trash2 } from "lucide-react";
import { menuSections, type PackageMenuEntry } from "../package-menu.ts";

const entry = (id: string, group: PackageMenuEntry["group"], hidden = false): PackageMenuEntry => ({
  id,
  group,
  icon: Trash2,
  label: id,
  hidden,
});

describe("menuSections", () => {
  it("draws the groups in menu order, whatever the order of the entries", () => {
    const sections = menuSections([
      entry("delete", "administration"),
      entry("fork", "build"),
      entry("download", "export"),
    ]);
    expect(sections.map((section) => section.group)).toEqual(["build", "export", "administration"]);
  });

  it("drops a group with no visible entry, so no separator is left for it", () => {
    const sections = menuSections([
      entry("fork", "build", true),
      entry("schedule", "execution"),
      entry("delete", "administration", true),
    ]);
    expect(sections.map((section) => section.group)).toEqual(["execution"]);
  });

  it("keeps the entries of a group in the order they were declared", () => {
    const [section] = menuSections([
      entry("clear-runs", "administration"),
      entry("activate", "administration"),
      entry("delete", "administration"),
    ]);
    expect(section!.entries.map((item) => item.id)).toEqual(["clear-runs", "activate", "delete"]);
  });
});
