// SPDX-License-Identifier: Apache-2.0

/** The skill picker's pure rules. */

import { describe, expect, it } from "bun:test";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  MAX_PINNED_SKILLS,
  type PinnedSkill,
} from "../src/skills.ts";
import {
  canResetSkills,
  citedSkillIds,
  effectiveSkills,
  exceedsBudget,
  loadsSkill,
  selectionOf,
  skillBudget,
  skillPickerRows,
  skillRowState,
  withPin,
  withSelection,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";

const pin = (
  id: string,
  status: PinnedSkill["status"] = "injected",
  chars: number | null = null,
): PinnedSkill => ({ id, status, chars });
const stored = (pins: PinnedSkill[] = [], skillDiscovery = true): StoredSkills => ({
  skillDiscovery,
  pins,
});

describe("withSelection", () => {
  it("writes the full set: kept pins keep their verdict, new ones have none, sorted", () => {
    const base = stored([pin("@a/kept", "over_budget", 70_000), pin("@a/dropped")]);
    expect(
      withSelection(base, { skillDiscovery: false, pins: ["@a/new", "@a/kept", "@a/new"] }),
    ).toEqual({
      skillDiscovery: false,
      pins: [pin("@a/kept", "over_budget", 70_000), pin("@a/new", null)],
    });
  });

  it("round-trips the server's state through its selection", () => {
    const base = stored([pin("@a/x"), pin("@a/y", null)], false);
    expect(withSelection(base, selectionOf(base))).toEqual(base);
  });
});

describe("withPin", () => {
  it("adds a pin once, sorted, and removes one", () => {
    const s = { skillDiscovery: true, pins: ["@a/b"] };
    expect(withPin(s, "@a/a", true).pins).toEqual(["@a/a", "@a/b"]);
    expect(withPin(s, "@a/b", true).pins).toEqual(["@a/b"]);
    expect(withPin(s, "@a/b", false).pins).toEqual([]);
  });
});

describe("skillRowState", () => {
  const skills = stored([
    pin("@a/mine"),
    pin("@a/unseen", null),
    pin("@a/big", "over_budget"),
    pin("@a/gone", "unavailable"),
    pin("@a/broken", "unreadable"),
  ]);
  const state = (id: string) => skillRowState(skills, id);

  it("reads each pin as the server reported it, pending until a turn judged it", () => {
    expect(state("@a/mine")).toEqual({ kind: "loaded" });
    expect(state("@a/unseen")).toEqual({ kind: "pending" });
    expect(state("@a/big")).toEqual({ kind: "refused", reason: "over_budget" });
    expect(state("@a/gone")).toEqual({ kind: "refused", reason: "unavailable" });
    expect(state("@a/broken")).toEqual({ kind: "refused", reason: "unreadable" });
    expect(state("@a/other")).toEqual({ kind: "off" });
  });

  it("never counts a refused pin as loaded, even cited; a cited skill not pinned loads", () => {
    expect(loadsSkill(state("@a/big"), true)).toBe(false);
    expect(loadsSkill(state("@a/other"), false)).toBe(false);
    expect(loadsSkill(state("@a/other"), true)).toBe(true);
    expect(loadsSkill(state("@a/unseen"), false)).toBe(true);
  });
});

describe("skillBudget", () => {
  const skills = stored([
    pin("@a/loaded", "injected", 10_000),
    pin("@a/new", null),
    pin("@a/big", "over_budget", 90_000),
  ]);
  const bytes = new Map([
    ["@a/new", 3_000],
    ["@a/cited", 2_000],
    ["@a/candidate", 60_000],
  ]);
  const of = (id: string) => bytes.get(id) ?? null;

  it("sums a loaded pin's chars and the listed size of a pending or cited skill, never a refused one", () => {
    const budget = skillBudget(
      skills,
      effectiveSkills(["@a/loaded", "@a/new", "@a/big"], ["@a/cited"]),
      of,
    );
    expect(budget).toEqual({ used: 15_000, max: CHAT_SKILLS_CONTENT_BUDGET_CHARS });
  });

  it("warns before pinning a skill that would take the total past the budget", () => {
    const budget = skillBudget(skills, effectiveSkills(["@a/loaded"], []), of);
    expect(exceedsBudget(budget, of("@a/candidate"))).toBe(true);
    expect(exceedsBudget(budget, of("@a/new"))).toBe(false);
    expect(exceedsBudget(budget, null)).toBe(false);
  });
});

describe("skillPickerRows", () => {
  const tone = { id: "@acme/tone", name: "Tone", description: "", version: "1.0.0", bytes: 120 };

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
        skill: { id: "@acme/gone", name: "gone", description: "", version: null, bytes: null },
        available: false,
      },
      {
        skill: { id: "@z/deleted", name: "deleted", description: "", version: null, bytes: null },
        available: false,
      },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      {
        skill: { id: "@acme/gone", name: "gone", description: "", version: null, bytes: null },
        available: false,
      },
    ]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});

const sk = (n: string) => `:skill[${n}]{name=@acme/${n}}`;

describe("citedSkillIds", () => {
  it("lists the skills a draft cites, once each, ignoring agents and plain text", () => {
    expect(citedSkillIds(`${sk("a")} x ${sk("b")} ${sk("a")} :agent[R]{name=run-r} /c`)).toEqual([
      "@acme/a",
      "@acme/b",
    ]);
    expect(citedSkillIds("nothing")).toEqual([]);
  });
});

describe("effectiveSkills", () => {
  it("is pinned then cited, a skill once, with the cited flag", () => {
    const e = effectiveSkills(["@acme/a", "@acme/b"], ["@acme/b", "@acme/c"]);
    expect(e.ids).toEqual(["@acme/a", "@acme/b", "@acme/c"]);
    expect([...e.cited]).toEqual(["@acme/b", "@acme/c"]);
  });

  it("counts the union against the cap", () => {
    const pinned = Array.from({ length: MAX_PINNED_SKILLS - 1 }, (_, i) => `@x/${i}`);
    expect(effectiveSkills(pinned, []).atCap).toBe(false);
    expect(effectiveSkills(pinned, ["@acme/a"]).atCap).toBe(true);
    expect(effectiveSkills(pinned, ["@acme/a"]).overCap).toBe(false);
    expect(effectiveSkills(pinned, ["@acme/a", "@acme/b"]).overCap).toBe(true);
    // Already pinned: no room taken.
    expect(effectiveSkills(pinned, ["@x/0"]).atCap).toBe(false);
  });
});

describe("canResetSkills", () => {
  it("is true with a pin or with discovery off, false on the default selection", () => {
    expect(canResetSkills(stored([pin("@acme/a")]))).toBe(true);
    expect(canResetSkills(stored([], false))).toBe(true);
    expect(canResetSkills(stored())).toBe(false);
  });
});
