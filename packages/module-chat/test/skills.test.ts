// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SKILL_SELECTION,
  resolveChatSkills,
  type ChatSkillSelection,
  type ResolveChatSkillsInput,
  type SkillHint,
} from "../src/skills.ts";

const hint = (id: string, source = "system"): SkillHint => ({
  package_id: id,
  display_name: id,
  description: "A skill.",
  version: "1.0.0",
  source,
});

function resolve(
  over: Omit<Partial<ResolveChatSkillsInput>, "selection"> & {
    selection?: Partial<ChatSkillSelection>;
  } = {},
) {
  const { selection, ...rest } = over;
  return resolveChatSkills({
    selection: { ...DEFAULT_SKILL_SELECTION, ...selection },
    defaults: [],
    requested: [],
    unresolved: [],
    catalogue: [],
    catalogueTruncated: false,
    ...rest,
  });
}

describe("resolveChatSkills", () => {
  it("indexes defaults and pins, sorted by package id whatever order they arrive in", () => {
    const out = resolve({
      defaults: ["@a/zulu", "@a/alpha"],
      selection: { pinned: ["@a/mike"] },
      requested: [hint("@a/mike"), hint("@a/zulu"), hint("@a/alpha")],
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/alpha", "@a/mike", "@a/zulu"]);
  });

  it("drops a requested hint nothing asked for, and de-duplicates the rest", () => {
    const out = resolve({
      defaults: ["@a/alpha"],
      requested: [hint("@a/alpha"), hint("@a/alpha"), hint("@a/stray")],
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/alpha"]);
  });

  it("tags each indexed skill as platform and/or pinned", () => {
    const out = resolve({
      defaults: ["@a/alpha", "@a/both"],
      selection: { pinned: ["@a/both", "@a/mine"] },
      requested: [hint("@a/alpha"), hint("@a/both"), hint("@a/mine")],
    });
    expect(out.indexed.map((s) => [s.package_id, s.platform, s.pinned])).toEqual([
      ["@a/alpha", true, false],
      ["@a/both", true, true],
      ["@a/mine", false, true],
    ]);
  });

  it("treats a default id an organization owns as that organization's skill", () => {
    const out = resolve({
      defaults: ["@a/alpha", "@a/owned"],
      requested: [hint("@a/alpha"), hint("@a/owned", "local")],
      catalogue: [hint("@a/owned", "local")],
    });
    expect(out.indexed.map((s) => [s.package_id, s.platform])).toEqual([["@a/alpha", true]]);
    expect(out.catalogue.map((s) => s.package_id)).toEqual(["@a/owned"]);

    const pinnedOwned = resolve({
      defaults: ["@a/owned"],
      selection: { pinned: ["@a/owned"] },
      requested: [hint("@a/owned", "local")],
    });
    expect(pinnedOwned.indexed.map((s) => [s.package_id, s.platform, s.pinned])).toEqual([
      ["@a/owned", false, true],
    ]);
  });

  it("catalogue on: shows the catalogue minus what is indexed, with its truncation", () => {
    const out = resolve({
      defaults: ["@a/alpha"],
      requested: [hint("@a/alpha")],
      catalogue: [hint("@a/alpha"), hint("@a/other")],
      catalogueTruncated: true,
    });
    expect(out.catalogue.map((s) => s.package_id)).toEqual(["@a/other"]);
    expect(out.catalogueTruncated).toBe(true);
  });

  it("catalogue off: still indexes defaults and pins, and shows no catalogue at all", () => {
    const out = resolve({
      selection: { catalogue: false, pinned: ["@a/mine"] },
      defaults: ["@a/alpha"],
      requested: [hint("@a/alpha"), hint("@a/mine")],
      catalogue: [hint("@a/other")],
      catalogueTruncated: true,
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/alpha", "@a/mine"]);
    expect(out.catalogue).toEqual([]);
    expect(out.catalogueTruncated).toBe(false);
  });

  it("notices an unresolved PIN and stays silent about an unresolved DEFAULT", () => {
    const out = resolve({
      defaults: ["@a/gone-default"],
      selection: { pinned: ["@a/gone-pin", "@a/here"] },
      requested: [hint("@a/here")],
      unresolved: ["@a/gone-default", "@a/gone-pin"],
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/here"]);
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]).toContain("@a/gone-pin");
    expect(out.notices.join("\n")).not.toContain("@a/gone-default");
  });

  it("orders notices deterministically and de-duplicates the pin list", () => {
    const out = resolve({
      selection: { pinned: ["@a/zulu", "@a/alpha", "@a/zulu"] },
      unresolved: ["@a/zulu", "@a/alpha"],
    });
    expect(out.notices).toHaveLength(2);
    expect(out.notices[0]).toContain("@a/alpha");
    expect(out.notices[1]).toContain("@a/zulu");
  });
});
