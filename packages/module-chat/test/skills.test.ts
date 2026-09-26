// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  MAX_SKILL_CONTENT_CHARS,
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

  it("leaves out a skill longer than the cap, with a notice naming both lengths", () => {
    const long = "x".repeat(MAX_SKILL_CONTENT_CHARS + 1);
    const exact = "y".repeat(MAX_SKILL_CONTENT_CHARS);
    const result = resolve({ skillMode: "strict", pinnedSkills: ["@a/exact", "@a/long"] }, [
      content("@a/long", long),
      content("@a/exact", exact),
    ]);
    expect(result.injected.map((s) => s.packageId)).toEqual(["@a/exact"]);
    expect(result.notices).toEqual([
      `The skill \`@a/long\` was chosen for this conversation but is too long to include (${MAX_SKILL_CONTENT_CHARS + 1} characters, limit ${MAX_SKILL_CONTENT_CHARS}).`,
    ]);
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
