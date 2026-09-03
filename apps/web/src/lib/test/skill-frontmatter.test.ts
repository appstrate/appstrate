// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { skillFrontmatterError, translateSkillFrontmatterError } from "../skill-frontmatter";
import { toApiError } from "../../api/client";
import fr from "../../locales/fr/agents.json";
import en from "../../locales/en/agents.json";

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

  it("carries the checker's own message as `detail`", () => {
    expect(
      skillFrontmatterError("---\nname: word-count\ndescription: a: b\n---\n")?.detail,
    ).toContain("not valid YAML");
  });
});

// The mapper is pure; what broke in review was the SHAPE it reads, so build the
// error the way the app does — a real problem+json through `toApiError` — and
// translate it against the real locale bundles.
function apiError(code: string, message = "…"): Promise<unknown> {
  return toApiError(
    new Response(
      JSON.stringify({
        type: "about:blank",
        title: "Validation Failed",
        status: 400,
        code: "validation_failed",
        detail: "content: skill SKILL.md must declare a non-empty 'description'",
        errors: [{ field: "content", code, title: "Invalid Content", message }],
      }),
      { status: 400, headers: { "content-type": "application/problem+json" } },
    ),
  );
}

/** Real locale JSON + i18next's `{{detail}}` interpolation, so a dropped detail shows up. */
const translator =
  (bundle: Record<string, string>) => (key: string, options?: { detail: string }) =>
    (bundle[key] ?? key).replace("{{detail}}", options?.detail ?? "");

describe("translateSkillFrontmatterError", () => {
  it("renders a server frontmatter code in both languages, WITH the detail", async () => {
    for (const bundle of [fr, en]) {
      const message = translateSkillFrontmatterError(
        await apiError("skill_invalid_frontmatter", "Map keys must be unique"),
        translator(bundle),
      );
      expect(message).toContain("Map keys must be unique");
      expect(message).not.toContain("{{detail}}");
    }
    expect(fr["editor.errorSkillInvalidFrontmatter"]).toContain("{{detail}}");
  });

  it("resolves the key to real prose, not the key itself", async () => {
    const message = translateSkillFrontmatterError(
      await apiError("skill_missing_frontmatter_description"),
      translator(fr),
    );
    expect(message).toBe(fr["editor.errorSkillFrontmatterDescription"]);
    expect(message).toContain("description");
  });

  it("returns null for a code it does not own, so the server detail stands", async () => {
    expect(
      translateSkillFrontmatterError(await apiError("name_collision"), translator(fr)),
    ).toBeNull();
    expect(translateSkillFrontmatterError(new Error("boom"), translator(fr))).toBeNull();
  });
});
