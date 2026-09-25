// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SKILL_SELECTION,
  MAX_SKILL_CONTENT_CHARS,
  resolveChatSkills,
  type ChatSkillSelection,
  type ResolveChatSkillsInput,
  type SkillContent,
  type SkillHint,
} from "../src/skills.ts";

const hint = (id: string): SkillHint => ({
  packageId: id,
  display_name: id,
  description: "A skill.",
  version: "1.0.0",
});

const content = (id: string, body = `# ${id}`): SkillContent => ({
  packageId: id,
  version: "1.0.0",
  content: body,
});

function resolve(
  over: Omit<Partial<ResolveChatSkillsInput>, "selection" | "contents"> & {
    selection?: Partial<ChatSkillSelection>;
    contents?: SkillContent[];
  } = {},
) {
  const { selection, contents = [], ...rest } = over;
  return resolveChatSkills({
    selection: { ...DEFAULT_SKILL_SELECTION, ...selection },
    requested: [],
    contents: new Map(contents.map((skill) => [skill.packageId, skill])),
    catalogue: [],
    catalogueTruncated: false,
    ...rest,
  });
}

describe("resolveChatSkills — auto", () => {
  it("lists the space's skills with their truncation, and injects nothing", () => {
    const result = resolve({
      selection: { pinnedSkills: ["@a/one"] },
      requested: [hint("@a/one")],
      contents: [content("@a/one")],
      catalogue: [hint("@a/one"), hint("@a/two")],
      catalogueTruncated: true,
    });
    expect(result.catalogue.map((s) => s.packageId)).toEqual(["@a/one", "@a/two"]);
    expect(result.catalogueTruncated).toBe(true);
    // The chosen skills are kept on the row but unused in `auto`.
    expect(result.injected).toEqual([]);
    expect(result.notices).toEqual([]);
  });
});

describe("resolveChatSkills — manual and strict", () => {
  for (const skillMode of ["manual", "strict"] as const) {
    it(`${skillMode}: injects the chosen skills that resolved, sorted, and lists no catalogue`, () => {
      const result = resolve({
        selection: { skillMode, pinnedSkills: ["@z/last", "@a/first"] },
        requested: [hint("@z/last"), hint("@a/first")],
        contents: [content("@z/last"), content("@a/first")],
        catalogue: [hint("@b/other")],
        catalogueTruncated: true,
      });
      expect(result.injected.map((s) => s.packageId)).toEqual(["@a/first", "@z/last"]);
      expect(result.catalogue).toEqual([]);
      expect(result.catalogueTruncated).toBe(false);
      expect(result.notices).toEqual([]);
    });
  }

  it("notices a chosen skill that is not active here, even when its content was read", () => {
    // `getSkill` reads a switched-off skill; only `requested_skills` says it is active.
    const result = resolve({
      selection: { skillMode: "manual", pinnedSkills: ["@a/off"] },
      requested: [],
      contents: [content("@a/off")],
    });
    expect(result.injected).toEqual([]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("`@a/off`");
    expect(result.notices[0]).toContain("not available");
  });

  it("notices an active chosen skill whose content could not be read", () => {
    const result = resolve({
      selection: { skillMode: "manual", pinnedSkills: ["@a/one"] },
      requested: [hint("@a/one")],
    });
    expect(result.injected).toEqual([]);
    expect(result.notices[0]).toContain("not available");
  });

  it("leaves out a skill longer than the cap, with a notice naming both lengths", () => {
    const long = "x".repeat(MAX_SKILL_CONTENT_CHARS + 1);
    const exact = "y".repeat(MAX_SKILL_CONTENT_CHARS);
    const result = resolve({
      selection: { skillMode: "strict", pinnedSkills: ["@a/long", "@a/exact"] },
      requested: [hint("@a/long"), hint("@a/exact")],
      contents: [content("@a/long", long), content("@a/exact", exact)],
    });
    expect(result.injected.map((s) => s.packageId)).toEqual(["@a/exact"]);
    expect(result.notices).toEqual([
      `The skill \`@a/long\` was chosen for this conversation but is too long to include (${MAX_SKILL_CONTENT_CHARS + 1} characters, limit ${MAX_SKILL_CONTENT_CHARS}).`,
    ]);
  });

  it("orders notices deterministically and de-duplicates the chosen list", () => {
    const result = resolve({
      selection: { skillMode: "manual", pinnedSkills: ["@z/gone", "@a/gone", "@z/gone"] },
    });
    expect(result.notices).toHaveLength(2);
    expect(result.notices[0]).toContain("`@a/gone`");
    expect(result.notices[1]).toContain("`@z/gone`");
  });
});
