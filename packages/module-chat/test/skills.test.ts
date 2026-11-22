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
  type SkillPinOutcome,
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
      `The skill \`@a/two\` is pinned to this conversation but does not fit (${third * 2} characters; the injected skills share ${BUDGET}, ${BUDGET - third * 2} left).`,
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
  const uri = (id: string) => `skill://space-1/${id.slice(1)}/${id.split("/")[1]}/SKILL.md`;
  const IDS = ["@a/in", "@a/new", "@a/next", "@a/big"];
  /** A loader over `IDS`, pinning through `pin` (each call recorded in `pinned`). */
  const loader = (
    pinned: string[],
    opts: { budgetLeft?: number; pin?: (id: string) => Promise<SkillPinOutcome> } = {},
  ) =>
    turnSkillLoad({
      uris: new Map(IDS.map((id) => [id, uri(id)])),
      injected: ["@a/in"],
      budgetLeft: opts.budgetLeft ?? 100,
      pin: async (id) => {
        pinned.push(id);
        return opts.pin ? opts.pin(id) : "pinned";
      },
    });

  it("answers a pin, without pinning again, for a skill the turn already injected", async () => {
    const pinned: string[] = [];
    expect(await loader(pinned)(uri("@a/in"), "x".repeat(1_000))).toBe(true);
    expect(pinned).toEqual([]);
  });

  it("pins a new skill once, out of the budget left", async () => {
    const pinned: string[] = [];
    const load = loader(pinned);
    expect(await load(uri("@a/new"), "x".repeat(60))).toBe(true);
    expect(await load(uri("@a/new"), "x".repeat(60))).toBe(true);
    await expect(load(uri("@a/next"), "y".repeat(41))).rejects.toThrow(/40 characters left/);
    expect(pinned).toEqual(["@a/new"]);
  });

  it("reads plainly any URI that is not the SKILL.md the conversation injects", async () => {
    const pinned: string[] = [];
    const load = loader(pinned);
    for (const other of [
      "skill://space-2/a/new/new/SKILL.md",
      "skill://space-1/a/new@draft/new/SKILL.md",
      "skill://space-1/a/new/new/guide.md",
      "skill://space-1/a/unknown/unknown/SKILL.md",
    ]) {
      expect(await load(other, "x")).toBe(false);
    }
    expect(pinned).toEqual([]);
  });

  it("refuses a skill over the budget left without pinning it", async () => {
    const pinned: string[] = [];
    await expect(loader(pinned, { budgetLeft: 5 })(uri("@a/new"), "x".repeat(6))).rejects.toThrow(
      /does not fit.*skills panel/,
    );
    expect(pinned).toEqual([]);
  });

  it("refuses a full conversation, and a turn that no longer holds it, giving the budget back", async () => {
    const pinned: string[] = [];
    let outcome: SkillPinOutcome = "full";
    const load = loader(pinned, { budgetLeft: 10, pin: async () => outcome });
    await expect(load(uri("@a/new"), "x".repeat(10))).rejects.toThrow(
      /already pins 5 skills.*unpin/,
    );
    outcome = "released";
    await expect(load(uri("@a/new"), "x".repeat(10))).rejects.toThrow(/no longer holds/);
    outcome = "pinned";
    // Both refusals gave the reservation back: the whole budget is still there.
    expect(await load(uri("@a/new"), "x".repeat(10))).toBe(true);
    expect(pinned).toEqual(["@a/new", "@a/new", "@a/new"]);
  });

  it("reserves the budget before awaiting the pin: parallel loads never overspend it", async () => {
    const pinned: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const load = loader(pinned, {
      budgetLeft: 100,
      pin: async () => {
        await gate;
        return "pinned";
      },
    });
    const first = load(uri("@a/new"), "x".repeat(60));
    // Same skill, in parallel: waits for the first load, counted once.
    const same = load(uri("@a/new"), "x".repeat(60));
    // Another skill that fits the budget alone, not what the first reserved.
    const other = load(uri("@a/next"), "y".repeat(60));
    await expect(other).rejects.toThrow(/40 characters left/);
    release();
    expect(await Promise.all([first, same])).toEqual([true, true]);
    expect(pinned).toEqual(["@a/new"]);
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
      "The skill `@a/odd` is pinned to this conversation but could not be read.",
    ]);
    expect(injectedSkills(result)).toEqual({});
  });

  it("is empty when nothing is injected", () => {
    expect(injectedSkills(resolve({ skillDiscovery: true, pinnedSkills: [] }))).toEqual({});
  });
});
