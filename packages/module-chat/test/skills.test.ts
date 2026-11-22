// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS as BUDGET,
  injectedSkills,
  parseSkillList,
  resolveChatSkills,
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
