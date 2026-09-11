// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of migration `0007`. The rewrite is allowed to change one
 * thing — whether `yaml` can read the block — and nothing else, so every case
 * here is either "it fixed exactly that" or "it refused".
 */

import { describe, it, expect } from "bun:test";
import { parseSkillFrontmatter } from "@appstrate/afps-shared/companion-files";
import {
  lenientSkillMeta,
  planFix,
  quoteDescriptionLine,
} from "../migration/0007-skill-frontmatter-quote-descriptions.ts";

const skill = (description: string, name = "word-count") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.`;

describe("quoteDescriptionLine", () => {
  it("single-quotes the description and leaves every other line alone", () => {
    expect(
      quoteDescriptionLine(`---\nname: a-b\ndescription: X : Y\nlicense: MIT\n---\nBody.`),
    ).toBe(`---\nname: a-b\ndescription: 'X : Y'\nlicense: MIT\n---\nBody.`);
  });

  // Nothing is escaped: a single-quoted scalar holds `"`, `\` and `#`
  // literally, which is the whole reason for choosing it.
  it("leaves double quotes, backslashes and hashes as the author wrote them", () => {
    const text = `He said "hi" \\ there : ok # note`;
    const rewritten = quoteDescriptionLine(skill(text))!;
    expect(rewritten).toContain(`description: '${text}'`);
    expect(parseSkillFrontmatter(rewritten).description).toBe(text);
  });

  // The one character a single-quoted scalar cannot hold without doubling.
  it("falls back to a literal block scalar when the text contains an apostrophe", () => {
    const text = `It's a "counter" \\ thing : here`;
    const rewritten = quoteDescriptionLine(skill(text))!;
    expect(rewritten).toContain(`description: |-\n  ${text}\n`);
    // Re-parses to the exact original text — no trailing newline, no escaping.
    expect(parseSkillFrontmatter(rewritten).description).toBe(text);
  });

  it("returns null when there is no frontmatter or no description line", () => {
    expect(quoteDescriptionLine("# just a body")).toBeNull();
    expect(quoteDescriptionLine("---\nname: a-b\n---\nBody.")).toBeNull();
  });
});

describe("planFix", () => {
  // The production shape: an unquoted colon-space that `yaml` refuses with
  // "Nested mappings are not allowed in compact mappings".
  it("fixes `description: a : b`", () => {
    const plan = planFix(skill("Counts words : and lines"));
    expect(plan.outcome).toBe("fixed");
    if (plan.outcome !== "fixed") return;
    expect(plan.content).toContain(`description: 'Counts words : and lines'`);
    // The fix is complete: the gate now passes, and a second pass is a no-op.
    expect(planFix(plan.content).outcome).toBe("conforming");
  });

  it("leaves a conforming SKILL.md untouched", () => {
    expect(planFix(skill("Counts words.")).outcome).toBe("conforming");
    expect(planFix(`---\nname: a-b\ndescription: |\n  Counts words.\n---\nBody.`).outcome).toBe(
      "conforming",
    );
  });

  // A description carrying a `"` is FIXED, not refused: four of production's
  // rows have one, and neither scalar form rewrites it.
  it("fixes a description containing a double quote", () => {
    const plan = planFix(skill(`He said "hi" : ok`));
    expect(plan.outcome).toBe("fixed");
    if (plan.outcome !== "fixed") return;
    expect(parseSkillFrontmatter(plan.content).description).toBe(`He said "hi" : ok`);
  });

  // The invariant is what the platform will READ after the fix vs what it
  // believed before. An inline comment on the NAME line is a real case where
  // the two readers disagree — `yaml` drops it, the pre-gate regex kept it —
  // so the row is left for a human rather than silently re-named.
  it("refuses when the fix would change the stored name or description", () => {
    const content = `---\nname: word-count # c\ndescription: a : b\n---\nBody.`;
    const rewritten = quoteDescriptionLine(content)!;
    // Discriminating: the rewrite itself is fine — the gate passes on it…
    expect(planFix(rewritten).outcome).toBe("conforming");
    // …but the two readers disagree about the name, so the fix is refused.
    expect(lenientSkillMeta(content).name).toBe("word-count # c");
    expect(parseSkillFrontmatter(rewritten).name).toBe("word-count");
    expect(planFix(content)).toMatchObject({
      outcome: "manual",
      reason: "the fix would change the stored name/description",
    });
  });

  it("refuses a name violation — quoting cannot fix it", () => {
    expect(planFix(skill("Counts words.", "Word Count"))).toMatchObject({ outcome: "manual" });
    // …including one that also breaks the YAML parse, where the rewrite runs
    // and the re-check is what catches it.
    expect(planFix(skill("Counts words : and lines", "Word_Count"))).toMatchObject({
      outcome: "manual",
      reason: "skill_invalid_frontmatter_name",
    });
  });

  it("refuses an over-long description and a missing one", () => {
    expect(planFix(skill("d".repeat(1025)))).toMatchObject({
      outcome: "manual",
      reason: "skill_invalid_frontmatter_description",
    });
    expect(planFix("---\nname: word-count\n---\nBody.")).toMatchObject({
      outcome: "manual",
      reason: "skill_missing_frontmatter_description",
    });
  });

  it("refuses a YAML fault quoting the description cannot repair", () => {
    // A duplicate key survives the rewrite, so the re-check refuses it.
    expect(planFix(`---\nname: a-b\ndescription: X : Y\ndescription: Z\n---\nBody.`)).toMatchObject(
      { outcome: "manual" },
    );
  });
});

describe("lenientSkillMeta", () => {
  it("reproduces the pre-gate reader, quotes stripped and longer keys not shadowing", () => {
    expect(
      lenientSkillMeta(
        `---\ndisplayname: Not It\nname: "word-count"\nx-description: Not it\ndescription: 'Counts words.'\n---\nBody.`,
      ),
    ).toEqual({ name: "word-count", description: "Counts words." });
    expect(lenientSkillMeta("# no frontmatter")).toEqual({ name: "", description: "" });
  });
});
