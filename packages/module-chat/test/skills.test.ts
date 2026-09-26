// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SKILLS_CONTENT_BUDGET_CHARS,
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

const resolve = (selection: ChatSkillSelection, contents: SkillContent[] = []) =>
  resolveChatSkills(selection, new Map(contents.map((skill) => [skill.packageId, skill])));

describe("resolveChatSkills", () => {
  it("auto: injects nothing and notices nothing — the chosen skills are kept but unused", () => {
    expect(resolve({ skillMode: "auto", pinnedSkills: ["@a/one"] }, [content("@a/one")])).toEqual({
      injected: [],
      notices: [],
    });
  });

  for (const skillMode of ["manual", "strict"] as const) {
    it(`${skillMode}: injects the chosen skills in their stored order`, () => {
      const result = resolve({ skillMode, pinnedSkills: ["@a/first", "@z/last"] }, [
        content("@z/last"),
        content("@a/first"),
      ]);
      expect(result.injected.map((s) => s.packageId)).toEqual(["@a/first", "@z/last"]);
      expect(result.notices).toEqual([]);
    });
  }

  it("notices a chosen skill that is not active here or could not be read", () => {
    const result = resolve({ skillMode: "manual", pinnedSkills: ["@a/gone", "@z/gone"] });
    expect(result.injected).toEqual([]);
    expect(result.notices).toHaveLength(2);
    expect(result.notices[0]).toContain("`@a/gone`");
    expect(result.notices[0]).toContain("not available");
    expect(result.notices[1]).toContain("`@z/gone`");
  });

  it("spends one budget across the chosen skills, in stored order", () => {
    const third = Math.floor(SKILLS_CONTENT_BUDGET_CHARS / 3);
    const result = resolve(
      { skillMode: "strict", pinnedSkills: ["@a/one", "@a/two", "@a/three"] },
      [
        content("@a/one", "x".repeat(third * 2)),
        // Over what is left after `@a/one`, though under the budget on its own.
        content("@a/two", "y".repeat(third * 2)),
        content("@a/three", "z".repeat(SKILLS_CONTENT_BUDGET_CHARS - third * 2)),
      ],
    );
    expect(result.injected.map((s) => s.packageId)).toEqual(["@a/one", "@a/three"]);
    expect(result.notices).toEqual([
      `The skill \`@a/two\` was chosen for this conversation but does not fit (${third * 2} characters; the chosen skills share ${SKILLS_CONTENT_BUDGET_CHARS}, ${SKILLS_CONTENT_BUDGET_CHARS - third * 2} left).`,
    ]);
  });

  it("injects one long skill that fits the budget", () => {
    const result = resolve({ skillMode: "manual", pinnedSkills: ["@a/art"] }, [
      content("@a/art", "a".repeat(19_735)),
    ]);
    expect(result.injected.map((s) => s.packageId)).toEqual(["@a/art"]);
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
