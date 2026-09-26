// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS as BUDGET,
  type EnforcedChatSkill,
} from "@appstrate/core/chat-contract";
import {
  parseSkillList,
  resolveChatSkills,
  type ChatSkillSelection,
  type SkillContent,
} from "../src/skills.ts";

const content = (id: string, body = `# ${id}`): SkillContent => ({
  packageId: id,
  version: "1.0.0",
  content: body,
});

const enforcedSkill = (id: string, body: string | null = `# ${id}`): EnforcedChatSkill => ({
  packageId: id,
  name: id,
  version: body === null ? null : "2.0.0",
  content: body,
});

const resolve = (
  selection: ChatSkillSelection,
  contents: SkillContent[] = [],
  enforced: EnforcedChatSkill[] = [],
) =>
  resolveChatSkills(
    selection,
    new Map(contents.map((skill) => [skill.packageId, skill])),
    enforced,
  );

describe("resolveChatSkills", () => {
  it("auto: injects nothing and notices nothing — the chosen skills are kept but unused", () => {
    expect(resolve({ skillMode: "auto", pinnedSkills: ["@a/one"] }, [content("@a/one")])).toEqual({
      enforced: [],
      chosen: [],
      notices: [],
    });
  });

  for (const skillMode of ["manual", "strict"] as const) {
    it(`${skillMode}: injects the chosen skills in their stored order`, () => {
      const result = resolve({ skillMode, pinnedSkills: ["@a/first", "@z/last"] }, [
        content("@z/last"),
        content("@a/first"),
      ]);
      expect(result.chosen.map((s) => s.packageId)).toEqual(["@a/first", "@z/last"]);
      expect(result.notices).toEqual([]);
    });
  }

  it("notices a chosen skill that is not active here or could not be read", () => {
    const result = resolve({ skillMode: "manual", pinnedSkills: ["@a/gone", "@z/gone"] });
    expect(result.chosen).toEqual([]);
    expect(result.notices).toHaveLength(2);
    expect(result.notices[0]).toContain("`@a/gone`");
    expect(result.notices[0]).toContain("not available");
    expect(result.notices[1]).toContain("`@z/gone`");
  });

  it("spends one budget across the chosen skills, in stored order", () => {
    const third = Math.floor(BUDGET / 3);
    const result = resolve(
      { skillMode: "strict", pinnedSkills: ["@a/one", "@a/two", "@a/three"] },
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
    const result = resolve({ skillMode: "manual", pinnedSkills: ["@a/art"] }, [
      content("@a/art", "a".repeat(19_735)),
    ]);
    expect(result.chosen.map((s) => s.packageId)).toEqual(["@a/art"]);
    expect(result.notices).toEqual([]);
  });
});

describe("resolveChatSkills — space-enforced skills", () => {
  for (const skillMode of ["auto", "manual", "strict"] as const) {
    it(`${skillMode}: injects the space's skills, in the platform's order, before any chosen one`, () => {
      const result = resolve(
        { skillMode, pinnedSkills: ["@a/mine"] },
        [content("@a/mine")],
        [enforcedSkill("@b/house"), enforcedSkill("@z/house")],
      );
      expect(result.enforced).toEqual([
        { packageId: "@b/house", version: "2.0.0", content: "# @b/house" },
        { packageId: "@z/house", version: "2.0.0", content: "# @z/house" },
      ]);
      expect(result.chosen.map((s) => s.packageId)).toEqual(
        skillMode === "auto" ? [] : ["@a/mine"],
      );
      expect(result.notices).toEqual([]);
    });
  }

  it("drops a pin naming an enforced skill, without a notice", () => {
    const result = resolve(
      { skillMode: "manual", pinnedSkills: ["@a/house", "@a/mine"] },
      [content("@a/house"), content("@a/mine")],
      [enforcedSkill("@a/house")],
    );
    expect(result.enforced.map((s) => s.packageId)).toEqual(["@a/house"]);
    expect(result.chosen.map((s) => s.packageId)).toEqual(["@a/mine"]);
    expect(result.notices).toEqual([]);
  });

  it("drops a pin naming an enforced skill even when that one has no readable version", () => {
    const result = resolve(
      { skillMode: "strict", pinnedSkills: ["@a/house"] },
      [content("@a/house")],
      [enforcedSkill("@a/house", null)],
    );
    expect(result.enforced).toEqual([]);
    expect(result.chosen).toEqual([]);
    // One notice, the space's: the user's pin says nothing more.
    expect(result.notices).toEqual([
      "The skill `@a/house` is required by this space but is not available here — it has no published version that can be read now.",
    ]);
  });

  it("spends the shared budget on the space's skills first", () => {
    const half = Math.floor(BUDGET / 2);
    const result = resolve(
      { skillMode: "manual", pinnedSkills: ["@a/mine"] },
      [content("@a/mine", "m".repeat(half))],
      [enforcedSkill("@a/house", "h".repeat(half + 1))],
    );
    expect(result.enforced.map((s) => s.packageId)).toEqual(["@a/house"]);
    expect(result.chosen).toEqual([]);
    expect(result.notices).toEqual([
      `The skill \`@a/mine\` was chosen for this conversation but does not fit (${half} characters; the injected skills share ${BUDGET}, ${BUDGET - half - 1} left).`,
    ]);
  });

  it("notices an enforced skill over what is left of the budget, and keeps a later one that fits", () => {
    const result = resolve(
      { skillMode: "auto", pinnedSkills: [] },
      [],
      [
        enforcedSkill("@a/a", "x".repeat(BUDGET - 10)),
        enforcedSkill("@a/b", "y".repeat(11)),
        enforcedSkill("@a/c", "z".repeat(10)),
      ],
    );
    expect(result.enforced.map((s) => s.packageId)).toEqual(["@a/a", "@a/c"]);
    expect(result.notices).toEqual([
      `The skill \`@a/b\` is required by this space but does not fit (11 characters; the injected skills share ${BUDGET}, 10 left).`,
    ]);
  });

  it("does not count the enforced skills against the pin cap", () => {
    const pins = ["@a/1", "@a/2", "@a/3", "@a/4", "@a/5"];
    const result = resolve(
      { skillMode: "manual", pinnedSkills: pins },
      pins.map((id) => content(id)),
      [enforcedSkill("@z/house")],
    );
    expect(result.chosen.map((s) => s.packageId)).toEqual(pins);
    expect(result.enforced.map((s) => s.packageId)).toEqual(["@z/house"]);
  });
});

describe("parseSkillList", () => {
  it("projects each row of the listing and drops a malformed one", () => {
    expect(
      parseSkillList({
        object: "list",
        data: [
          { id: "@acme/tone", name: "Tone", description: "Adjusts tone", version: "1.2.0" },
          { id: "@acme/bare", name: "@acme/bare", description: null, version: null },
          { id: 42 },
        ],
      }),
    ).toEqual([
      {
        packageId: "@acme/tone",
        display_name: "Tone",
        description: "Adjusts tone",
        version: "1.2.0",
      },
      { packageId: "@acme/bare", display_name: "@acme/bare", description: null, version: null },
    ]);
  });

  it("reads an unreadable body as no skills", () => {
    expect(parseSkillList(null)).toEqual([]);
    expect(parseSkillList({ data: "nope" })).toEqual([]);
  });
});
