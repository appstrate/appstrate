// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n";
import { skillFrontmatterError } from "../skill-frontmatter";
import { errorMessage } from "../mutation-error";
import { ApiError } from "../../api/errors";

await i18nReady;

// The i18n instance is shared by every suite of the run, and they expect French.
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

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

  it("names the rule by key only, never by the checker's English sentence", async () => {
    await i18n.changeLanguage("fr");
    // The parser stopped on SKILL.md's line 3 (its block starts after the opening `---`).
    expect(skillFrontmatterError("---\nname: word-count\ndescription: a: b\n---\n")).toEqual({
      key: "editor.errorSkillInvalidFrontmatter",
      params: { position: " (ligne 3, colonne 14)" },
    });
    // Rules that carry no position say none.
    expect(skillFrontmatterError("# no frontmatter")).toMatchObject({ params: { position: "" } });
  });

  it("says where the YAML broke in both languages, from the server's refusal too", async () => {
    const refusal = new ApiError(
      "validation_failed",
      "content: Map keys must be unique at line 3, column 1:",
      400,
      [
        {
          field: "content",
          code: "skill_invalid_frontmatter",
          message:
            "skill SKILL.md frontmatter is not valid YAML: Map keys must be unique at line 3, column 1:",
        },
      ],
    );
    await i18n.changeLanguage("fr");
    expect(errorMessage(refusal)).toStartWith(
      "Le frontmatter YAML de SKILL.md est invalide (ligne 4, colonne 1) : ",
    );
    await i18n.changeLanguage("en");
    expect(errorMessage(refusal)).toStartWith(
      "SKILL.md's YAML frontmatter is invalid (line 4, column 1): ",
    );
    expect(errorMessage(refusal)).not.toContain("Map keys");
    await i18n.changeLanguage("fr");
  });
});
