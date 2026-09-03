// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { skillFrontmatterError } from "../skill-frontmatter";
import {
  skillFrontmatterErrorKeyForApiCode,
  translateSkillFrontmatterError,
} from "../skill-frontmatter-messages";
import { toApiError } from "../../api/client";
import fr from "../../locales/fr/agents.json";
import en from "../../locales/en/agents.json";

describe("skillFrontmatterError", () => {
  it("accepts a conforming SKILL.md", () => {
    expect(
      skillFrontmatterError("---\nname: word-count\ndescription: Counts words.\n---\nBody."),
    ).toBeNull();
  });

  it("names the missing frontmatter name", () => {
    expect(skillFrontmatterError("# no frontmatter")).toMatchObject({
      key: "editor.errorSkillFrontmatterName",
    });
  });

  it("names an invalid frontmatter name", () => {
    expect(
      skillFrontmatterError("---\nname: Word_Count\ndescription: Counts words.\n---\nBody."),
    ).toMatchObject({ key: "editor.errorSkillInvalidName" });
  });

  it("names the missing description — the editor's default skeleton", () => {
    // `DEFAULT_SKILL_CONTENT` with only the name filled in.
    expect(skillFrontmatterError("---\nname: word-count\ndescription: \n---\n\n")).toMatchObject({
      key: "editor.errorSkillFrontmatterDescription",
    });
  });

  it("accepts a block-scalar description — the editor must not nag about legal YAML", () => {
    expect(
      skillFrontmatterError(
        "---\nname: word-count\ndescription: |\n  Counts words in a text.\n---\nBody.",
      ),
    ).toBeNull();
  });

  // A duplicate key is a YAML fault, not a length fault: it must NOT render
  // the "description too long" message the previous hand parser mapped it to.
  it("names a duplicate key as invalid frontmatter, not as an over-long description", () => {
    const key = skillFrontmatterError(
      "---\nname: word-count\ndescription: a\ndescription: b\n---\n",
    );
    expect(key).toMatchObject({ key: "editor.errorSkillInvalidFrontmatter" });
    expect(key?.key).not.toBe("editor.errorSkillDescriptionTooLong");
  });

  it("names a YAML syntax error as invalid frontmatter", () => {
    expect(skillFrontmatterError("---\nname: word-count\ndescription: a: b\n---\n")).toMatchObject({
      key: "editor.errorSkillInvalidFrontmatter",
    });
  });

  it("rejects a leading BOM and says so, rather than stripping it", () => {
    const err = skillFrontmatterError(
      "\uFEFF---\nname: word-count\ndescription: Counts words.\n---\nBody.",
    );
    expect(err?.key).toBe("editor.errorSkillInvalidFrontmatter");
    expect(err?.detail).toContain("byte-order mark");
  });

  // The translated strings promise "the exact fault"; the checker's own
  // sentence is the only part that names the offending line or bound, so it
  // has to travel with the key.
  it("carries the checker's own message as `detail`", () => {
    expect(
      skillFrontmatterError("---\nname: word-count\ndescription: a: b\n---\n")?.detail,
    ).toContain("not valid YAML");
    expect(
      skillFrontmatterError(`---\nname: word-count\ndescription: ${"d".repeat(1025)}\n---\n`)
        ?.detail,
    ).toContain("1024");
  });

  it("names an over-long description", () => {
    expect(
      skillFrontmatterError(`---\nname: word-count\ndescription: ${"d".repeat(1025)}\n---\n`),
    ).toMatchObject({ key: "editor.errorSkillDescriptionTooLong" });
  });
});

describe("skillFrontmatterErrorKeyForApiCode", () => {
  it("maps the API's lowercased companion reasons", () => {
    expect(skillFrontmatterErrorKeyForApiCode("skill_missing_frontmatter_description")).toBe(
      "editor.errorSkillFrontmatterDescription",
    );
    expect(skillFrontmatterErrorKeyForApiCode("skill_invalid_frontmatter_name")).toBe(
      "editor.errorSkillInvalidName",
    );
  });

  it("returns null for a code it does not own, so the server detail stands", () => {
    expect(skillFrontmatterErrorKeyForApiCode("name_collision")).toBeNull();
  });
});

// ── Wiring, not mapping ─────────────────────────────────────────────
//
// The mapper above is pure. What broke in review was the SHAPE of the thing it
// reads: `ApiError.details` IS the problem body's `errors` array, and reading
// `details.errors` matched nothing while type-checking fine. So build the error
// the way the app does — from a real problem+json Response through the client's
// own `toApiError` — and translate it against the real locale bundles.
function problemResponse(code: string, message = "…"): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Validation Failed",
      status: 400,
      code: "validation_failed",
      detail: `content: skill SKILL.md must declare a non-empty 'description' in YAML frontmatter`,
      errors: [{ field: "content", code, title: "Invalid Content", message }],
    }),
    { status: 400, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * `t` backed by the real flat dotted-key locale JSON, with i18next's
 * `{{detail}}` interpolation done the same way — so a message that promises a
 * detail and never receives one shows up as a literal `{{detail}}`.
 */
const translator =
  (bundle: Record<string, string>) => (key: string, options?: { detail: string }) =>
    (bundle[key] ?? key).replace("{{detail}}", options?.detail ?? "");

/** The real `ApiError` the app would see for `code`, carrying `message`. */
const apiError = (code: string, message?: string) => toApiError(problemResponse(code, message));

describe("translateSkillFrontmatterError", () => {
  it("renders the French message for a server frontmatter code", async () => {
    const err = await toApiError(problemResponse("skill_missing_frontmatter_description"));
    const message = translateSkillFrontmatterError(err, translator(fr));
    expect(message).toBe(fr["editor.errorSkillFrontmatterDescription"]);
    // The key must have resolved to real prose, not fallen through as the key.
    expect(message).not.toBe("editor.errorSkillFrontmatterDescription");
    expect(message).toContain("description");
  });

  it("renders the new invalid-frontmatter code in both languages, WITH the detail", async () => {
    // The string ends in `{{detail}}`; a translation that dropped it would
    // promise an explanation and show none.
    for (const bundle of [fr, en]) {
      const message = translateSkillFrontmatterError(
        await apiError(
          "skill_invalid_frontmatter",
          "frontmatter is not valid YAML: Map keys must be unique",
        ),
        translator(bundle),
      );
      expect(message).toContain("Map keys must be unique");
      expect(message).not.toContain("{{detail}}");
    }
    expect(fr["editor.errorSkillInvalidFrontmatter"]).toContain("{{detail}}");
  });

  it("renders the English message for the same code", async () => {
    const err = await toApiError(problemResponse("skill_invalid_frontmatter_name", "bad name"));
    expect(translateSkillFrontmatterError(err, translator(en))).toBe(
      en["editor.errorSkillInvalidName"].replace("{{detail}}", "bad name"),
    );
  });

  it("returns null for a code it does not own, so the server detail stands", async () => {
    const err = await toApiError(problemResponse("name_collision"));
    expect(translateSkillFrontmatterError(err, translator(fr))).toBeNull();
  });

  it("returns null for a non-ApiError", () => {
    expect(translateSkillFrontmatterError(new Error("boom"), translator(fr))).toBeNull();
  });
});
