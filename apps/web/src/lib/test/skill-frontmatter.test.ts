// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { skillFrontmatterError } from "../skill-frontmatter";

describe("skillFrontmatterError", () => {
  it("accepts a conforming SKILL.md", () => {
    expect(
      skillFrontmatterError("---\nname: word-count\ndescription: Counts words.\n---\nBody."),
    ).toBeNull();
  });

  it("maps each violation to its own message key", () => {
    expect(skillFrontmatterError("# no frontmatter")).toMatchObject({
      key: "editor.errorSkillFrontmatterName",
    });
    expect(
      skillFrontmatterError("---\nname: Word_Count\ndescription: Counts words.\n---\nBody."),
    ).toMatchObject({ key: "editor.errorSkillInvalidName" });
    expect(skillFrontmatterError("---\nname: word-count\ndescription: \n---\n\n")).toMatchObject({
      key: "editor.errorSkillFrontmatterDescription",
    });
    expect(
      skillFrontmatterError(`---\nname: word-count\ndescription: ${"d".repeat(1025)}\n---\n`),
    ).toMatchObject({ key: "editor.errorSkillDescriptionTooLong" });
    expect(
      skillFrontmatterError("---\nname: word-count\ndescription: a\ndescription: b\n---\n"),
    ).toMatchObject({ key: "editor.errorSkillInvalidFrontmatter" });
  });

  it("does not nag about legal YAML the server accepts", () => {
    expect(
      skillFrontmatterError(
        "---\nname: word-count\ndescription: |\n  Counts words in a text.\n---\nBody.",
      ),
    ).toBeNull();
  });

  it("names the rule by key only, never by the checker's English sentence", () => {
    expect(skillFrontmatterError("---\nname: word-count\ndescription: a: b\n---\n")).toEqual({
      key: "editor.errorSkillInvalidFrontmatter",
    });
  });
});
