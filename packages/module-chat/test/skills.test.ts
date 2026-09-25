// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SKILL_SELECTION,
  resolveChatSkills,
  type ChatSkillSelection,
  type ResolveChatSkillsInput,
  type SkillHint,
} from "../src/skills.ts";

const hint = (id: string): SkillHint => ({
  packageId: id,
  display_name: id,
  description: "A skill.",
  version: "1.0.0",
});

function resolve(
  over: Omit<Partial<ResolveChatSkillsInput>, "selection"> & {
    selection?: Partial<ChatSkillSelection>;
  } = {},
) {
  const { selection, ...rest } = over;
  return resolveChatSkills({
    selection: { ...DEFAULT_SKILL_SELECTION, ...selection },
    requested: [],
    catalogue: [],
    catalogueTruncated: false,
    ...rest,
  });
}

describe("resolveChatSkills", () => {
  it("indexes the pins, sorted by package id whatever order they arrive in", () => {
    const out = resolve({
      selection: { pinnedSkills: ["@a/mike", "@a/alpha", "@a/zulu"] },
      requested: [hint("@a/mike"), hint("@a/zulu"), hint("@a/alpha")],
    });
    expect(out.pinned.map((s) => s.packageId)).toEqual(["@a/alpha", "@a/mike", "@a/zulu"]);
  });

  it("drops a requested hint nothing pinned, and de-duplicates the rest", () => {
    const out = resolve({
      selection: { pinnedSkills: ["@a/alpha"] },
      requested: [hint("@a/alpha"), hint("@a/alpha"), hint("@a/stray")],
    });
    expect(out.pinned.map((s) => s.packageId)).toEqual(["@a/alpha"]);
  });

  it("catalogue on: shows the catalogue minus what is pinned, with its truncation", () => {
    const out = resolve({
      selection: { pinnedSkills: ["@a/alpha"] },
      requested: [hint("@a/alpha")],
      catalogue: [hint("@a/alpha"), hint("@a/other")],
      catalogueTruncated: true,
    });
    expect(out.catalogue.map((s) => s.packageId)).toEqual(["@a/other"]);
    expect(out.catalogueTruncated).toBe(true);
  });

  it("catalogue off: still indexes the pins, and shows no catalogue at all", () => {
    const out = resolve({
      selection: { skillCatalogue: false, pinnedSkills: ["@a/mine"] },
      requested: [hint("@a/mine")],
      catalogue: [hint("@a/other")],
      catalogueTruncated: true,
    });
    expect(out.pinned.map((s) => s.packageId)).toEqual(["@a/mine"]);
    expect(out.catalogue).toEqual([]);
    expect(out.catalogueTruncated).toBe(false);
  });

  it("notices a pin the context did not resolve, and nothing else", () => {
    const out = resolve({
      selection: { pinnedSkills: ["@a/gone-pin", "@a/here"] },
      requested: [hint("@a/here")],
      catalogue: [hint("@a/other")],
    });
    expect(out.pinned.map((s) => s.packageId)).toEqual(["@a/here"]);
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]).toContain("@a/gone-pin");
  });

  it("orders notices deterministically and de-duplicates the pin list", () => {
    const out = resolve({
      selection: { pinnedSkills: ["@a/zulu", "@a/alpha", "@a/zulu"] },
    });
    expect(out.notices).toHaveLength(2);
    expect(out.notices[0]).toContain("@a/alpha");
    expect(out.notices[1]).toContain("@a/zulu");
  });
});
