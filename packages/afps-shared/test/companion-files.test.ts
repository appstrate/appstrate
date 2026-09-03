// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  checkCompanionFiles,
  checkSkillMarkdown,
  companionFilesFromRecord,
  isValidSkillName,
  parseSkillFrontmatter,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  type CompanionViolationReason,
} from "../src/companion-files.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** The producer gate over a single SKILL.md payload. */
function checkSkill(skillMd: string): CompanionViolationReason | null {
  return checkSkillMarkdown(skillMd)?.reason ?? null;
}

/** The loader gate over an archive. */
function checkArchive(skillMd: string | null): CompanionViolationReason | null {
  const files: Record<string, Uint8Array> = skillMd === null ? {} : { "SKILL.md": enc(skillMd) };
  return checkCompanionFiles({ type: "skill" }, companionFilesFromRecord(files))?.reason ?? null;
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Body`;

describe("parseSkillFrontmatter", () => {
  it("reports found:false when there is no frontmatter block", () => {
    expect(parseSkillFrontmatter("# Just a heading")).toMatchObject({ found: false, name: "" });
  });

  it("tells an unclosed block apart from no frontmatter at all", () => {
    expect(parseSkillFrontmatter("---\nname: word-count\nno closing fence")).toMatchObject({
      found: false,
      unterminated: true,
    });
  });

  it("reads name and description, quotes stripped, from an LF or CRLF document", () => {
    expect(parseSkillFrontmatter(skillMd("word-count", "Counts words."))).toMatchObject({
      found: true,
      name: "word-count",
      description: "Counts words.",
    });
    expect(
      parseSkillFrontmatter(`---\r\nname: "word-count"\r\ndescription: 'Counts words.'\r\n---\r\n`),
    ).toMatchObject({ found: true, name: "word-count", description: "Counts words." });
  });

  // Pi tests `startsWith("---")`, so it reads no frontmatter behind a BOM. A
  // parser that saw through it would report fields the runtime never sees.
  it("reads NOTHING behind a UTF-8 BOM, exactly as the runtime does", () => {
    expect(parseSkillFrontmatter(`\uFEFF${skillMd("word-count", "Counts words.")}`)).toMatchObject({
      found: false,
      unterminated: false,
      name: "",
    });
  });

  it("does not let a longer key shadow the real top-level field", () => {
    expect(
      parseSkillFrontmatter(
        "---\ndisplayname: Not The Name\nx-description: Not it\n" +
          "name: word-count\ndescription: Counts words.\n---\nbody",
      ),
    ).toMatchObject({ name: "word-count", description: "Counts words." });
  });
});

describe("isValidSkillName", () => {
  it("accepts lowercase alphanumerics with single inner hyphens, up to 64 chars", () => {
    expect(isValidSkillName("a")).toBe(true);
    expect(isValidSkillName("a1-b2-c3")).toBe(true);
    expect(isValidSkillName("a".repeat(SKILL_NAME_MAX_LENGTH))).toBe(true);
  });

  it("rejects other characters, edge hyphens, doubled hyphens and 65 chars", () => {
    for (const bad of ["Word-Count", "word_count", "word count", "wörd", "-w", "w-", "w--c"]) {
      expect(isValidSkillName(bad)).toBe(false);
    }
    expect(isValidSkillName("a".repeat(SKILL_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("checkSkillMarkdown — the producer gate", () => {
  it("accepts a conforming SKILL.md", () => {
    expect(checkSkill(skillMd("word-count", "Counts words in a text."))).toBeNull();
  });

  it("reports one reason per rule, in order", () => {
    expect(checkSkill("# no frontmatter")).toBe("SKILL_MISSING_FRONTMATTER_NAME");
    expect(checkSkill("---\nname:   \ndescription: d\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_NAME",
    );
    expect(checkSkill(skillMd("Bad_Name", "d"))).toBe("SKILL_INVALID_FRONTMATTER_NAME");
    expect(checkSkill(skillMd(`${"a".repeat(65)}`, "d"))).toBe("SKILL_INVALID_FRONTMATTER_NAME");
    expect(checkSkill("---\nname: word-count\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_DESCRIPTION",
    );
    expect(checkSkill(skillMd("word-count", "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1)))).toBe(
      "SKILL_INVALID_FRONTMATTER_DESCRIPTION",
    );
    // A bad name AND a missing description reports the name first.
    expect(checkSkill("---\nname: Bad_Name\ndescription:\n---\nbody")).toBe(
      "SKILL_INVALID_FRONTMATTER_NAME",
    );
  });

  it("accepts the exact bounds", () => {
    expect(checkSkill(skillMd("a".repeat(SKILL_NAME_MAX_LENGTH), "d"))).toBeNull();
    expect(checkSkill(skillMd("word-count", "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH)))).toBeNull();
  });

  // Lengths bound the author's TEXT. `"🙂".length` is 2 in JS, so a UTF-16
  // count would reject a description the spec allows.
  it("counts code points, not UTF-16 units", () => {
    expect(checkSkill(skillMd("word-count", "🙂".repeat(SKILL_DESCRIPTION_MAX_LENGTH)))).toBeNull();
    expect(checkSkill(skillMd("word-count", "🙂".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1)))).toBe(
      "SKILL_INVALID_FRONTMATTER_DESCRIPTION",
    );
  });

  it("names the rule in the message so the author knows what to fix", () => {
    const nameViolation = checkSkillMarkdown(skillMd("Bad_Name", "x"));
    expect(nameViolation?.message).toContain("lowercase");
    expect(nameViolation?.message).toContain("Bad_Name");
    expect(nameViolation?.path).toBe("SKILL.md");
    expect(checkSkillMarkdown("---\nname: word-count\n---\nbody")?.message).toContain(
      "description",
    );
    expect(checkSkillMarkdown("---\nname: word-count\nno fence")?.message).toContain("not closed");
  });

  // A BOM'd document has no readable frontmatter at all, so every later rule
  // would report a missing name — true, but not the thing to fix.
  it("rejects a BOM before any other rule, naming it rather than stripping it", () => {
    const bom = "\uFEFF---\r\nname: word-count\r\n---\r\nbody";
    expect(checkSkill(bom)).toBe("SKILL_INVALID_FRONTMATTER");
    expect(checkSkillMarkdown(bom)?.message).toContain("byte-order mark");
  });

  // Parity with the consumer is the contract: the runtime parses the block with
  // `yaml` at this major, so these assert what THAT library returns — not what
  // the hand-rolled scanner this replaces happened to do.
  it.each([
    [
      "literal block scalar",
      "description: |\n  Counts words.\n  Use for stats.",
      "Counts words.\nUse for stats.",
    ],
    [
      "folded block scalar",
      "description: >\n  Counts words\n  in a text.",
      "Counts words in a text.",
    ],
    ["chomped block scalar", "description: |-\n  Real text.", "Real text."],
    ["next-line plain scalar", "description:\n  Counts words.", "Counts words."],
    ["trailing comment", "description: Counts words. # why", "Counts words."],
    ["unquoted #", "description: Writes C# code", "Writes C# code"],
    ["quoted #", `description: "a # b"`, "a # b"],
    ["escaped quotes", `description: "Use \\"grep\\" first."`, 'Use "grep" first.'],
  ])("reads a %s the way YAML does", (_label, line, expected) => {
    const fm = `---\nname: word-count\n${line}\n---\nBody`;
    expect(parseSkillFrontmatter(fm).description).toBe(expected);
    expect(checkSkill(fm)).toBeNull();
  });

  it.each([
    ["a `: ` inside an unquoted value", "---\nname: word-count\ndescription: a: b\n---\n"],
    ["a key with no space after the colon", "---\nname:word-count\ndescription: d\n---\n"],
    ["a duplicate key", "---\nname: a\nname: b\ndescription: d\n---\n"],
    ["a non-mapping document", "---\n- a\n- b\n---\n"],
    ["a non-string field", "---\nname: 123\ndescription: d\n---\n"],
  ])("rejects %s, as YAML does", (_label, fm) => {
    expect(checkSkill(fm)).toBe("SKILL_INVALID_FRONTMATTER");
  });

  // `description:` and `description: null` are indistinguishable once parsed
  // and both mean "not provided" — a missing field, not a YAML complaint.
  it("treats an empty or explicitly-null scalar as ABSENT, not malformed", () => {
    for (const fm of [
      "---\nname: word-count\ndescription:\n---\n",
      "---\nname: word-count\ndescription: null\n---\n",
      `---\nname: word-count\ndescription: "  "\n---\n`,
      "---\nname: word-count\ndescription: |\n---\n",
    ]) {
      expect(checkSkill(fm)).toBe("SKILL_MISSING_FRONTMATTER_DESCRIPTION");
    }
  });
});

// Containment: everything the producer gate accepts, the loader accepts. The
// two read the frontmatter differently on purpose — a real YAML parser in the
// gate, a frozen substring probe in the loader — and YAML is the more
// permissive of the two. Without this invariant, publishing mints an IMMUTABLE
// version the run launcher cannot load.
describe("containment — the gate accepts a SUBSET of what the loader accepts", () => {
  it.each([
    ["plain", "---\nname: word-count\ndescription: Counts words.\n---\nBody"],
    ["quoted", `---\nname: "word-count"\ndescription: 'Counts words.'\n---\n`],
    ["commented", "---\nname: word-count # slug\ndescription: Counts words. # why\n---\n"],
    ["CRLF", "---\r\nname: word-count\r\ndescription: Counts words.\r\n---\r\n"],
    ["block scalar", "---\nname: word-count\ndescription: |\n  Counts words.\n---\n"],
    ["folded", "---\nname: word-count\ndescription: >\n  Counts words.\n---\n"],
    ["next-line", "---\nname: word-count\ndescription:\n  Counts words.\n---\n"],
    ["extra keys", "---\nlicense: MIT\nname: word-count\ndescription: d\n---\n"],
    ["64-char name", `---\nname: ${"a".repeat(64)}\ndescription: d\n---\n`],
    ["1024-code-point description", `---\nname: n\ndescription: ${"🙂".repeat(1024)}\n---\n`],
  ])("loader also accepts: %s", (_label, content) => {
    // Positive control first: a gate that silently started rejecting
    // everything could not pass this.
    expect(checkSkill(content)).toBeNull();
    expect(checkArchive(content)).toBeNull();
  });

  it.each([
    ["name on the following line", "---\nname:\n  triage\ndescription: Counts words.\n---\n"],
    ["space before the colon", "---\nname : triage\ndescription: Counts words.\n---\n"],
  ])("refuses %s — valid YAML the loader cannot read", (_label, content) => {
    // The parser (matching the runtime) reads the name fine…
    expect(parseSkillFrontmatter(content).name).toBe("triage");
    // …the loader probe does not…
    expect(checkArchive(content)).toBe("SKILL_MISSING_FRONTMATTER_NAME");
    // …so the gate refuses to mint it, naming the fix.
    expect(checkSkill(content)).toBe("SKILL_INVALID_FRONTMATTER_NAME");
    expect(checkSkillMarkdown(content)?.message).toContain("inline on one line");
  });
});

// `checkCompanionFiles` also runs on the LOADER side (`extractRootFromAfps` →
// the run launcher's package catalog). Tightening it would fail every run of an
// agent whose published skill dependency predates the stricter rule.
describe("checkCompanionFiles — the loader side stays lenient", () => {
  it("accepts what the producer rule refuses", () => {
    expect(checkArchive("---\nname: triage\n---\nbody")).toBeNull();
    expect(checkArchive(skillMd("Legacy_Name", ""))).toBeNull();
    expect(checkArchive(skillMd("@acme/triage", ""))).toBeNull();
    expect(checkArchive(skillMd("triage", "d".repeat(5000)))).toBeNull();
    // …and the producer side really does refuse them.
    expect(checkSkill("---\nname: triage\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_DESCRIPTION",
    );
    expect(checkSkill(skillMd("Legacy_Name", "d"))).toBe("SKILL_INVALID_FRONTMATTER_NAME");
  });

  // The substring probe is frozen, so these keep loading: each could sit in a
  // published, immutable artifact today, and the column-0 parser reads none of
  // them as a name.
  it("accepts frontmatter shapes that declare no top-level `name` at all", () => {
    for (const fm of [
      "---\nmetadata:\n  name: triage\n---\nbody",
      "---\nskill_name: triage\n---\nbody",
    ]) {
      expect(checkArchive(fm)).toBeNull();
      expect(parseSkillFrontmatter(fm).name).toBe("");
    }
  });

  it("still requires SKILL.md to exist and to name something", () => {
    expect(checkArchive(null)).toBe("SKILL_MISSING_SKILL_MD");
    expect(checkArchive("# no frontmatter")).toBe("SKILL_MISSING_FRONTMATTER_NAME");
  });
});

describe("checkCompanionFiles — other package types are untouched", () => {
  it("still enforces agent prompt.md", () => {
    expect(checkCompanionFiles({ type: "agent" }, companionFilesFromRecord({}))?.reason).toBe(
      "AGENT_MISSING_PROMPT",
    );
    expect(
      checkCompanionFiles({ type: "agent" }, companionFilesFromRecord({ "prompt.md": enc("  ") }))
        ?.reason,
    ).toBe("AGENT_EMPTY_PROMPT");
    expect(
      checkCompanionFiles({ type: "agent" }, companionFilesFromRecord({ "prompt.md": enc("hi") })),
    ).toBeNull();
  });

  it("requires no companion for an integration", () => {
    expect(checkCompanionFiles({ type: "integration" }, companionFilesFromRecord({}))).toBeNull();
  });
});
