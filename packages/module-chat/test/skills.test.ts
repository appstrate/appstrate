// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  applySkillChanges,
  CHAT_SKILLS_CONTENT_BUDGET_CHARS as BUDGET,
  injectedSkills,
  pinnedSkillsOf,
  resolveChatSkills,
  selectionAfter,
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
      injected: [],
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
      expect(result.injected.map((s) => s.packageId)).toEqual(["@a/first", "@z/last"]);
      expect(result.notices).toEqual([]);
    });
  }

  it("notices a pinned skill that is not active here or could not be read", () => {
    const result = resolve({ skillDiscovery: true, pinnedSkills: ["@a/gone", "@z/gone"] });
    expect(result.injected).toEqual([]);
    expect(result.notices).toHaveLength(2);
    expect(result.notices[0]).toContain("`@a/gone`");
    expect(result.notices[0]).toContain("not available");
    expect(result.notices[1]).toContain("`@z/gone`");
  });

  it("spends one budget across the pinned skills, in stored order", () => {
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
    expect(result.injected.map((s) => s.packageId)).toEqual(["@a/one", "@a/three"]);
    expect(result.notices).toEqual([
      `The skill \`@a/two\` is pinned to this conversation but does not fit (${third * 2} characters; the injected skills share ${BUDGET}, ${BUDGET - third * 2} left).`,
    ]);
  });

  it("injects one long skill that fits the budget", () => {
    const result = resolve({ skillDiscovery: true, pinnedSkills: ["@a/art"] }, [
      content("@a/art", "a".repeat(19_735)),
    ]);
    expect(result.injected.map((s) => s.packageId)).toEqual(["@a/art"]);
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
  it("gives each pin its source and status, null when unknown", () => {
    expect(
      pinnedSkillsOf({
        id: "chs_1",
        pinnedSkills: ["@a/a", "@a/m", "@a/z"],
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

describe("selectionAfter", () => {
  it("applies the pins and the discovery switch, keeping what the changes leave", () => {
    const stored = { skillDiscovery: true, pinnedSkills: ["@a/a", "@a/c"] };
    expect(selectionAfter(stored, { pin: ["@a/b"], unpin: ["@a/c"] })).toEqual({
      skillDiscovery: true,
      pinnedSkills: ["@a/a", "@a/b"],
    });
    expect(selectionAfter(stored, { skillDiscovery: false, pin: [], unpin: [] })).toEqual({
      skillDiscovery: false,
      pinnedSkills: ["@a/a", "@a/c"],
    });
  });
});

// The database side of each outcome (what is written, the receipt, the notes) is in
// `skill-load-pin.test.ts`; this covers the turn's own bookkeeping.
describe("turnSkillLoad", () => {
  const uri = (id: string) => `skill://space-1/${id.slice(1)}/${id.split("/")[1]}/SKILL.md`;
  const IDS = ["@a/in", "@a/left", "@a/new", "@a/next"];
  type Pin = (id: string, append: boolean) => Promise<SkillPinOutcome>;
  /** A loader over `IDS` (`@a/in` injected, `@a/left` pinned but left out), each pin call recorded. */
  const loader = (calls: string[], opts: { budgetLeft?: number; pin?: Pin } = {}) =>
    turnSkillLoad({
      uris: new Map(IDS.map((id) => [id, uri(id)])),
      pinned: ["@a/in", "@a/left"],
      injected: ["@a/in"],
      budgetLeft: opts.budgetLeft ?? 100,
      pin: async (id, append) => {
        calls.push(`${append ? "pin" : "check"} ${id}`);
        if (opts.pin) return opts.pin(id, append);
        return append ? "pinned" : "already_pinned";
      },
    });

  it("checks, without appending or spending budget, a skill the turn injected", async () => {
    const calls: string[] = [];
    const load = loader(calls, { budgetLeft: 0 });
    expect(await load(uri("@a/in"), "x".repeat(1_000))).toEqual({ pinned: true });
    expect(calls).toEqual(["check @a/in"]);
  });

  it("reads plainly, without a pin, a skill unpinned since the turn injected it", async () => {
    const calls: string[] = [];
    const load = loader(calls, { pin: async () => "not_pinned" });
    expect(await load(uri("@a/in"), "x")).toEqual({ pinned: false });
    expect(calls).toEqual(["check @a/in"]);
  });

  it("reads plainly a pin the turn left out, attempting no pin and spending no budget", async () => {
    const calls: string[] = [];
    const load = loader(calls, { budgetLeft: 0 });
    expect(await load(uri("@a/left"), "x".repeat(1_000))).toEqual({ pinned: false });
    expect(calls).toEqual([]);
  });

  it("pins a new skill once, out of the budget left; a re-read only checks it", async () => {
    const calls: string[] = [];
    const load = loader(calls);
    expect(await load(uri("@a/new"), "x".repeat(60))).toEqual({ pinned: true });
    expect(await load(uri("@a/new"), "x".repeat(60))).toEqual({ pinned: true });
    expect(await load(uri("@a/next"), "y".repeat(41))).toMatchObject({ pinned: false });
    expect(calls).toEqual(["pin @a/new", "check @a/new"]);
  });

  it("is undefined for any URI that is not the SKILL.md the conversation injects", async () => {
    const calls: string[] = [];
    const load = loader(calls);
    for (const other of [
      "skill://space-2/a/new/new/SKILL.md",
      "skill://space-1/a/new@draft/new/SKILL.md",
      "skill://space-1/a/new/new/guide.md",
      "skill://space-1/a/unknown/unknown/SKILL.md",
    ]) {
      expect(await load(other, "x")).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it("gives the reservation back when a pin is refused or fails", async () => {
    const calls: string[] = [];
    const outcomes: Array<SkillPinOutcome | Error> = ["full", "released", new Error("db down")];
    const load = loader(calls, {
      budgetLeft: 10,
      pin: async (_id, append) => {
        const next = append ? outcomes.shift() : "already_pinned";
        if (next instanceof Error) throw next;
        return next ?? "pinned";
      },
    });
    for (let i = 0; i < 3; i++) {
      const refused = await load(uri("@a/new"), "x".repeat(10));
      expect(refused?.pinned).toBe(false);
      expect(refused?.note).toContain("read for this turn but not pinned");
    }
    // Every refusal gave the reservation back: the whole budget is still there.
    expect(await load(uri("@a/new"), "x".repeat(10))).toEqual({ pinned: true });
    expect(calls).toEqual(["pin @a/new", "pin @a/new", "pin @a/new", "pin @a/new"]);
  });

  it("reserves the budget before awaiting the pin: parallel loads never overspend it", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const load = loader(calls, {
      budgetLeft: 100,
      pin: async (_id, append) => {
        if (!append) return "already_pinned";
        await gate;
        return "pinned";
      },
    });
    const first = load(uri("@a/new"), "x".repeat(60));
    // Same skill, in parallel: waits for the first load, counted once.
    const same = load(uri("@a/new"), "x".repeat(60));
    // Another skill that fits the budget alone, not what the first reserved.
    const other = await load(uri("@a/next"), "y".repeat(60));
    expect(other?.note).toContain("40 characters left");
    release();
    expect(await Promise.all([first, same])).toEqual([{ pinned: true }, { pinned: true }]);
    expect(calls).toEqual(["pin @a/new", "check @a/new"]);
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

  it("notices a pinned skill the platform answered malformed, and names it nowhere", () => {
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
