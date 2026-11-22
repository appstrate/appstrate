// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  applySkillChanges,
  CHAT_SKILLS_CONTENT_BUDGET_CHARS as BUDGET,
  injectedSkills,
  pinnedSkillsOf,
  resolveChatSkills,
  turnSkillLoad,
  type ChatSkillSelection,
  type SkillContent,
} from "../src/skills.ts";

const content = (id: string, body = `# ${id}`): SkillContent => ({
  packageId: id,
  version: "1.0.0",
  uri: `skill://space-1/${id.slice(1)}/skill/SKILL.md`,
  content: body,
  served: { definition: "published", version: "1.0.0", spaceId: "space-1" },
});

const resolve = (selection: ChatSkillSelection, contents: SkillContent[] = []) =>
  resolveChatSkills(selection, new Map(contents.map((skill) => [skill.packageId, skill])));

describe("resolveChatSkills", () => {
  it("injects nothing when no skill is pinned", () => {
    expect(resolve({ skillDiscovery: true, pinnedSkills: [] })).toEqual({
      chosen: [],
      notices: [],
      statuses: {},
      left: BUDGET,
    });
  });

  for (const skillDiscovery of [true, false]) {
    it(`discovery ${skillDiscovery ? "on" : "off"}: injects the pinned skills in their stored order`, () => {
      const result = resolve({ skillDiscovery, pinnedSkills: ["@a/first", "@z/last"] }, [
        content("@z/last"),
        content("@a/first"),
      ]);
      expect(result.chosen.map((s) => s.packageId)).toEqual(["@a/first", "@z/last"]);
      expect(result.notices).toEqual([]);
    });
  }

  it("notices a chosen skill that is not active here or could not be read", () => {
    const result = resolve({ skillDiscovery: true, pinnedSkills: ["@a/gone", "@z/gone"] });
    expect(result.chosen).toEqual([]);
    expect(result.notices).toHaveLength(2);
    expect(result.notices[0]).toContain("`@a/gone`");
    expect(result.notices[0]).toContain("not available");
    expect(result.notices[1]).toContain("`@z/gone`");
  });

  it("spends one budget across the chosen skills, in stored order", () => {
    const third = Math.floor(BUDGET / 3);
    const result = resolve(
      { skillDiscovery: false, pinnedSkills: ["@a/one", "@a/two", "@a/three"] },
      [
        content("@a/one", "x".repeat(third * 2)),
        // Over what is left after `@a/one`, though under the budget on its own.
        content("@a/two", "y".repeat(third * 2)),
        content("@a/three", "z".repeat(BUDGET - third * 2)),
      ],
    );
    expect(result.chosen.map((s) => s.packageId)).toEqual(["@a/one", "@a/three"]);
    expect(result.notices).toEqual([
      `The skill \`@a/two\` was chosen for this conversation but does not fit (${third * 2} characters; the injected skills share ${BUDGET}, ${BUDGET - third * 2} left).`,
    ]);
  });

  it("injects one long skill that fits the budget", () => {
    const result = resolve({ skillDiscovery: true, pinnedSkills: ["@a/art"] }, [
      content("@a/art", "a".repeat(19_735)),
    ]);
    expect(result.chosen.map((s) => s.packageId)).toEqual(["@a/art"]);
    expect(result.notices).toEqual([]);
  });
});

describe("resolveChatSkills statuses", () => {
  it("gives each pin its verdict and the budget the injected ones leave", () => {
    const result = resolveChatSkills(
      { skillDiscovery: true, pinnedSkills: ["@a/big", "@a/gone", "@a/odd", "@a/ok", "@a/over"] },
      new Map<string, SkillContent | null>([
        ["@a/big", content("@a/big", "x".repeat(BUDGET - 10))],
        ["@a/odd", null],
        ["@a/ok", content("@a/ok", "y".repeat(4))],
        ["@a/over", content("@a/over", "z".repeat(7))],
      ]),
    );
    expect(result.statuses).toEqual({
      "@a/big": "injected",
      "@a/gone": "unavailable",
      "@a/odd": "unreadable",
      "@a/ok": "injected",
      "@a/over": "over_budget",
    });
    expect(result.left).toBe(6);
  });
});

describe("applySkillChanges", () => {
  it("drops the unpins, adds the pins, sorted and deduped", () => {
    expect(
      applySkillChanges(["@a/c", "@a/a"], { pin: ["@a/b", "@a/a"], unpin: ["@a/c", "@a/x"] }),
    ).toEqual(["@a/a", "@a/b"]);
  });

  it("is idempotent", () => {
    const changes = { pin: ["@a/b"], unpin: ["@a/a"] };
    const once = applySkillChanges(["@a/a"], changes);
    expect(applySkillChanges(once, changes)).toEqual(once);
  });
});

describe("pinnedSkillsOf", () => {
  it("sorts the pins and gives each its source and status, null when unknown", () => {
    expect(
      pinnedSkillsOf({
        pinnedSkills: ["@a/z", "@a/m", "@a/a"],
        assistantSkills: ["@a/m"],
        skillStatus: { "@a/a": "over_budget", "@a/m": "injected", "@a/z": "bogus" },
      }),
    ).toEqual([
      { id: "@a/a", source: "user", status: "over_budget" },
      { id: "@a/m", source: "assistant", status: "injected" },
      { id: "@a/z", source: "user", status: null },
    ]);
  });
});

describe("turnSkillLoad", () => {
  const loader = (pinned: string[], full = false, budgetLeft = 100) =>
    turnSkillLoad({
      injected: ["@a/in"],
      budgetLeft,
      pin: async (id) => {
        if (full) return false;
        pinned.push(id);
        return true;
      },
    });

  it("reads a skill the turn already injected without pinning it", async () => {
    const pinned: string[] = [];
    expect(await loader(pinned)("@a/in", "x".repeat(1_000))).toBe("read");
    expect(pinned).toEqual([]);
  });

  it("pins a new skill, then reads it again plainly, out of the budget left", async () => {
    const pinned: string[] = [];
    const load = loader(pinned);
    expect(await load("@a/new", "x".repeat(60))).toBe("pinned");
    expect(await load("@a/new", "x".repeat(60))).toBe("read");
    await expect(load("@a/next", "y".repeat(41))).rejects.toThrow(/40 characters left/);
    expect(pinned).toEqual(["@a/new"]);
  });

  it("refuses a skill over the budget left without pinning it", async () => {
    const pinned: string[] = [];
    await expect(loader(pinned, false, 5)("@a/new", "x".repeat(6))).rejects.toThrow(
      /does not fit.*skills panel/,
    );
    expect(pinned).toEqual([]);
  });

  it("refuses when the conversation already pins the most skills", async () => {
    await expect(loader([], true)("@a/new", "x")).rejects.toThrow(/already pins 5 skills.*unpin/);
  });
});

describe("injectedSkills", () => {
  it("names exactly the injected definitions, never a noticed or over-budget one", () => {
    const result = resolve(
      { skillDiscovery: false, pinnedSkills: ["@a/mine", "@a/gone", "@a/big"] },
      [
        {
          ...content("@a/mine"),
          served: { definition: "draft", lockVersion: 3, spaceId: "space-1" },
        },
        content("@a/big", "x".repeat(BUDGET)),
      ],
    );
    expect(injectedSkills(result)).toEqual({
      "@a/mine": { definition: "draft", lockVersion: 3, spaceId: "space-1" },
    });
  });

  it("notices a chosen skill the platform answered malformed, and names it nowhere", () => {
    const result = resolveChatSkills(
      { skillDiscovery: true, pinnedSkills: ["@a/odd"] },
      new Map([["@a/odd", null]]),
    );
    expect(result.notices).toEqual([
      "The skill `@a/odd` was chosen for this conversation but could not be read.",
    ]);
    expect(injectedSkills(result)).toEqual({});
  });

  it("is empty when nothing is injected", () => {
    expect(injectedSkills(resolve({ skillDiscovery: true, pinnedSkills: [] }))).toEqual({});
  });
});
