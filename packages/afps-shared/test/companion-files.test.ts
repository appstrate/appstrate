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

/** The PRODUCER gate over a single SKILL.md payload. */
function checkSkill(skillMd: string): CompanionViolationReason | null {
  return checkSkillMarkdown(skillMd)?.reason ?? null;
}

/** The LOADER gate over an archive. */
function checkArchive(skillMd: string | null): CompanionViolationReason | null {
  const files: Record<string, Uint8Array> = skillMd === null ? {} : { "SKILL.md": enc(skillMd) };
  return checkCompanionFiles({ type: "skill" }, companionFilesFromRecord(files))?.reason ?? null;
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Body`;

describe("parseSkillFrontmatter", () => {
  it("reports found:false when there is no frontmatter block", () => {
    expect(parseSkillFrontmatter("# Just a heading")).toMatchObject({
      found: false,
      name: "",
      description: "",
    });
  });

  it("reads name and description from an LF document", () => {
    expect(parseSkillFrontmatter(skillMd("word-count", "Counts words."))).toMatchObject({
      found: true,
      name: "word-count",
      description: "Counts words.",
    });
  });

  it("reads CRLF line endings", () => {
    const crlf = "---\r\nname: word-count\r\ndescription: Counts words.\r\n---\r\n# Body";
    expect(parseSkillFrontmatter(crlf)).toMatchObject({
      found: true,
      name: "word-count",
      description: "Counts words.",
    });
  });

  it("reads NOTHING behind a UTF-8 BOM, exactly as the runtime does", () => {
    // Pi's `parseFrontmatter` tests `startsWith("---")`. A parser that saw
    // through the BOM would report fields the runtime never reads — the
    // divergence this whole module exists to prevent.
    const bom = `\uFEFF${skillMd("word-count", "Counts words.")}`;
    expect(parseSkillFrontmatter(bom)).toMatchObject({
      found: false,
      name: "",
      description: "",
    });
    const both = "\uFEFF---\r\nname: word-count\r\ndescription: Counts words.\r\n---\r\nbody";
    expect(parseSkillFrontmatter(both)).toMatchObject({ found: false, name: "" });
  });

  it("strips one layer of matching surrounding quotes", () => {
    const quoted = `---\nname: "word-count"\ndescription: 'Counts words.'\n---\nbody`;
    expect(parseSkillFrontmatter(quoted)).toMatchObject({
      found: true,
      name: "word-count",
      description: "Counts words.",
    });
  });

  it("does not let a longer key shadow the real top-level field", () => {
    const shadowed =
      "---\ndisplayname: Not The Name\nx-description: Not the description\n" +
      "name: word-count\ndescription: Counts words.\n---\nbody";
    expect(parseSkillFrontmatter(shadowed)).toMatchObject({
      found: true,
      name: "word-count",
      description: "Counts words.",
    });
  });
});

describe("isValidSkillName", () => {
  it("accepts lowercase alphanumerics and single inner hyphens", () => {
    expect(isValidSkillName("a")).toBe(true);
    expect(isValidSkillName("word-count")).toBe(true);
    expect(isValidSkillName("a1-b2-c3")).toBe(true);
  });

  it("rejects uppercase, underscores and other characters", () => {
    expect(isValidSkillName("Word-Count")).toBe(false);
    expect(isValidSkillName("word_count")).toBe(false);
    expect(isValidSkillName("word count")).toBe(false);
    expect(isValidSkillName("wörd")).toBe(false);
  });

  it("rejects leading, trailing and consecutive hyphens", () => {
    expect(isValidSkillName("-word")).toBe(false);
    expect(isValidSkillName("word-")).toBe(false);
    expect(isValidSkillName("word--count")).toBe(false);
  });

  it("accepts exactly 64 characters and rejects 65", () => {
    expect(isValidSkillName("a".repeat(SKILL_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidSkillName("a".repeat(SKILL_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("checkSkillMarkdown — skill frontmatter (AFPS §3.3, producer side)", () => {
  it("accepts a conforming SKILL.md", () => {
    expect(checkSkill(skillMd("word-count", "Counts words in a text."))).toBeNull();
  });

  it("reports the checks in order: name, name shape, description, description length", () => {
    // No frontmatter at all is a missing name.
    expect(checkSkill("# no frontmatter")).toBe("SKILL_MISSING_FRONTMATTER_NAME");
    // Bad name AND missing description → the name is reported first.
    expect(checkSkill("---\nname: Bad_Name\ndescription:\n---\nbody")).toBe(
      "SKILL_INVALID_FRONTMATTER_NAME",
    );
  });

  it("rejects an absent name", () => {
    expect(checkSkill("---\ndescription: Counts words.\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_NAME",
    );
  });

  it("rejects a blank name", () => {
    expect(checkSkill("---\nname:   \ndescription: Counts words.\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_NAME",
    );
  });

  it("rejects a name that breaks the Agent Skills naming rule", () => {
    for (const bad of ["Word-Count", "word_count", "-word", "word-", "word--count"]) {
      expect(checkSkill(skillMd(bad, "Counts words."))).toBe("SKILL_INVALID_FRONTMATTER_NAME");
    }
  });

  it("accepts a 64-char name and rejects a 65-char one", () => {
    const at = "a".repeat(SKILL_NAME_MAX_LENGTH);
    expect(checkSkill(skillMd(at, "Counts words."))).toBeNull();
    expect(checkSkill(skillMd(`${at}a`, "Counts words."))).toBe("SKILL_INVALID_FRONTMATTER_NAME");
  });

  it("rejects an absent description", () => {
    expect(checkSkill("---\nname: word-count\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_DESCRIPTION",
    );
  });

  it("rejects a blank / whitespace-only description", () => {
    expect(checkSkill("---\nname: word-count\ndescription:    \n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_DESCRIPTION",
    );
    expect(checkSkill(`---\nname: word-count\ndescription: "  "\n---\nbody`)).toBe(
      "SKILL_MISSING_FRONTMATTER_DESCRIPTION",
    );
  });

  it("accepts a 1024-char description and rejects a 1025-char one", () => {
    expect(checkSkill(skillMd("word-count", "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH)))).toBeNull();
    expect(checkSkill(skillMd("word-count", "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1)))).toBe(
      "SKILL_INVALID_FRONTMATTER_DESCRIPTION",
    );
  });

  it("applies the same rules to a CRLF document", () => {
    const crlf = "---\r\nname: word-count\r\ndescription: Counts words.\r\n---\r\nbody";
    expect(checkSkill(crlf)).toBeNull();
    const crlfNoDesc = "---\r\nname: word-count\r\n---\r\nbody";
    expect(checkSkill(crlfNoDesc)).toBe("SKILL_MISSING_FRONTMATTER_DESCRIPTION");
  });

  it("rejects a BOM before any other rule, so the message names the real fault", () => {
    // A BOM'd document has no readable frontmatter at all, so every later rule
    // would report a missing name — true, but not the thing to fix.
    const bom = "\uFEFF---\r\nname: word-count\r\n---\r\nbody";
    expect(checkSkill(bom)).toBe("SKILL_INVALID_FRONTMATTER");
    expect(checkSkillMarkdown(bom)?.message).toContain("byte-order mark");
  });

  it("names the rule in the message so the author knows what to fix", () => {
    const nameViolation = checkSkillMarkdown(skillMd("Bad_Name", "x"));
    expect(nameViolation?.message).toContain("lowercase");
    expect(nameViolation?.message).toContain("Bad_Name");
    expect(nameViolation?.path).toBe("SKILL.md");

    const descViolation = checkSkillMarkdown("---\nname: word-count\n---\nbody");
    expect(descViolation?.message).toContain("description");
  });

  // Lengths are bounds on the author's TEXT. `"🙂".length` is 2 in JS, so a
  // UTF-16 count rejects a 33-emoji name the spec allows.
  it("counts code points, not UTF-16 units", () => {
    expect(checkSkill(skillMd("word-count", "🙂".repeat(SKILL_DESCRIPTION_MAX_LENGTH)))).toBeNull();
    expect(checkSkill(skillMd("word-count", "🙂".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1)))).toBe(
      "SKILL_INVALID_FRONTMATTER_DESCRIPTION",
    );
    // A name of 64 emoji is still not a legal name — but for its SHAPE, not
    // its length, which is what the message must say.
    expect(isValidSkillName("🙂".repeat(SKILL_NAME_MAX_LENGTH))).toBe(false);
  });
});

describe("parseSkillFrontmatter — YAML semantics, from the `yaml` library", () => {
  // Parity with the consumer is the contract: the runtime that loads a skill
  // (`@earendil-works/pi-coding-agent`, `dist/utils/frontmatter.js`) parses the
  // block with `yaml` at this major. These cases assert what THAT library
  // returns, not what a hand-rolled scanner happened to do.

  it("reads a literal block scalar (|)", () => {
    const fm =
      "---\nname: word-count\ndescription: |\n  Counts words in a text.\n  Use for length stats.\n---\nBody";
    expect(parseSkillFrontmatter(fm).description).toBe(
      "Counts words in a text.\nUse for length stats.",
    );
    expect(checkSkill(fm)).toBeNull();
  });

  it("reads a folded block scalar (>)", () => {
    const fm = "---\nname: word-count\ndescription: >\n  Counts words\n  in a text.\n---\nBody";
    expect(parseSkillFrontmatter(fm).description).toBe("Counts words in a text.");
  });

  it("reads block scalars with chomping / indent indicators", () => {
    for (const header of ["|-", "|+", ">-", ">+", "|2", ">2"]) {
      const fm = `---\nname: word-count\ndescription: ${header}\n  Real text.\n---\nBody`;
      expect(parseSkillFrontmatter(fm).description).toBe("Real text.");
      expect(checkSkill(fm)).toBeNull();
    }
  });

  it("reads a plain scalar continued on the following indented lines", () => {
    const fm = "---\nname: word-count\ndescription:\n  Counts words in a text.\n---\nBody";
    expect(parseSkillFrontmatter(fm).description).toBe("Counts words in a text.");
    expect(checkSkill(fm)).toBeNull();
  });

  it("bounds the length of a block scalar's real text, not its indicator", () => {
    const long = `---\nname: word-count\ndescription: |\n  ${"d".repeat(
      SKILL_DESCRIPTION_MAX_LENGTH + 1,
    )}\n---\nBody`;
    expect(checkSkill(long)).toBe("SKILL_INVALID_FRONTMATTER_DESCRIPTION");
    const empty = "---\nname: word-count\ndescription: |\n---\nBody";
    expect(checkSkill(empty)).toBe("SKILL_MISSING_FRONTMATTER_DESCRIPTION");
  });

  it("does not let an indented key inside a block shadow the top-level field", () => {
    const fm =
      "---\nname: word-count\ndescription: |\n  name: not-the-name\n  Real text.\n---\nBody";
    expect(parseSkillFrontmatter(fm).name).toBe("word-count");
    expect(parseSkillFrontmatter(fm).description).toBe("name: not-the-name\nReal text.");
  });

  it("strips an unquoted trailing comment", () => {
    const fm = "---\nname: word-count # the slug\ndescription: Counts words. # why\n---\nBody";
    expect(parseSkillFrontmatter(fm)).toMatchObject({
      name: "word-count",
      description: "Counts words.",
    });
    expect(checkSkill(fm)).toBeNull();
  });

  it("keeps a # that is part of the text", () => {
    expect(
      parseSkillFrontmatter("---\nname: word-count\ndescription: Writes C# code\n---\n")
        .description,
    ).toBe("Writes C# code");
    expect(
      parseSkillFrontmatter(`---\nname: word-count\ndescription: "a # b"\n---\n`).description,
    ).toBe("a # b");
  });

  it("keeps quotes inside quoted scalars", () => {
    expect(
      parseSkillFrontmatter(
        `---\nname: word-count\ndescription: "Use \\"grep\\" first, then count."\n---\n`,
      ).description,
    ).toBe('Use "grep" first, then count.');
    expect(
      parseSkillFrontmatter("---\nname: word-count\ndescription: 'It''s a counter.'\n---\n")
        .description,
    ).toBe("It's a counter.");
  });

  it("reads CRLF", () => {
    expect(
      parseSkillFrontmatter("---\r\nname: word-count\r\ndescription: Counts words.\r\n---\r\nbody"),
    ).toMatchObject({ found: true, name: "word-count", description: "Counts words." });
  });

  // Pi tests `startsWith("---")`, which a BOM defeats — it reads NO frontmatter
  // and drops the skill. Mirroring that is the point: a parser that saw
  // through the BOM would report fields the runtime never sees.
  it("sees no frontmatter behind a BOM, exactly as the runtime does", () => {
    const bom = "\uFEFF---\nname: word-count\ndescription: Counts words.\n---\nbody";
    expect(parseSkillFrontmatter(bom)).toMatchObject({
      found: false,
      unterminated: false,
      name: "",
      description: "",
    });
  });

  it("rejects a BOM with a message naming it, rather than rewriting the bytes", () => {
    const bom = "\uFEFF---\nname: word-count\ndescription: Counts words.\n---\nbody";
    expect(checkSkill(bom)).toBe("SKILL_INVALID_FRONTMATTER");
    expect(checkSkillMarkdown(bom)?.message).toContain("byte-order mark");
  });

  // ── what the hand-rolled scanner used to wave through ──
  it("rejects a `: ` inside an unquoted value, as YAML does", () => {
    const fm = "---\nname: word-count\ndescription: a: b\n---\n";
    expect(parseSkillFrontmatter(fm).error).toContain("not valid YAML");
    expect(checkSkill(fm)).toBe("SKILL_INVALID_FRONTMATTER");
  });

  it("rejects a key with no space after the colon, as YAML does", () => {
    const fm = "---\nname:word-count\ndescription: d\n---\n";
    expect(checkSkill(fm)).toBe("SKILL_INVALID_FRONTMATTER");
  });

  it("rejects duplicate keys, as YAML does (uniqueKeys)", () => {
    // js-yaml and `yaml` both refuse; PyYAML would keep the last. No value the
    // platform picked would be right everywhere, so the document is refused.
    const fm = "---\nname: first\nname: second\ndescription: d\n---\n";
    expect(checkSkill(fm)).toBe("SKILL_INVALID_FRONTMATTER");
    expect(checkSkillMarkdown(fm)?.message).toContain("not valid YAML");
  });

  it("rejects a non-mapping document", () => {
    expect(checkSkill("---\n- a\n- b\n---\n")).toBe("SKILL_INVALID_FRONTMATTER");
    expect(checkSkillMarkdown("---\n- a\n- b\n---\n")?.message).toContain("expected a mapping");
  });

  it("rejects a field that is not a string", () => {
    expect(checkSkill("---\nname: 123\ndescription: d\n---\n")).toBe("SKILL_INVALID_FRONTMATTER");
    expect(checkSkillMarkdown("---\nname: 123\ndescription: d\n---\n")?.message).toContain(
      "'name' must be a string, got a number",
    );
    expect(checkSkill("---\nname: n\ndescription:\n  - a\n  - b\n---\n")).toBe(
      "SKILL_INVALID_FRONTMATTER",
    );
  });

  it("treats an empty or explicitly-null scalar as ABSENT, not malformed", () => {
    // `description:` and `description: null` are indistinguishable once parsed
    // and both mean "not provided" — the author gets the missing-field message,
    // not a YAML complaint.
    for (const fm of [
      "---\nname: word-count\ndescription:\n---\n",
      "---\nname: word-count\ndescription: null\n---\n",
    ]) {
      expect(checkSkill(fm)).toBe("SKILL_MISSING_FRONTMATTER_DESCRIPTION");
    }
  });

  // ── unterminated frontmatter block ──
  it("tells an unclosed frontmatter block apart from no frontmatter at all", () => {
    const unterminated = "---\nname: word-count\ndescription: d\nBody with no closing fence";
    expect(parseSkillFrontmatter(unterminated)).toMatchObject({
      found: false,
      unterminated: true,
    });
    expect(checkSkillMarkdown(unterminated)?.message).toContain("not closed");

    expect(parseSkillFrontmatter("# no frontmatter")).toMatchObject({ unterminated: false });
    expect(checkSkillMarkdown("# no frontmatter")?.message).toContain("must declare a 'name'");
  });
});

// ─────────────────────────────────────────────────────────────────────
// CONTAINMENT: everything the producer gate accepts, the loader accepts.
//
// The two read the frontmatter differently on purpose — a real YAML parser in
// the gate, a frozen substring probe in the loader — and YAML is the more
// permissive of the two. Without this invariant, create/publish mints an
// IMMUTABLE version the run launcher cannot load, which is unfixable.
//
// This is the table that would have caught it.
// ─────────────────────────────────────────────────────────────────────
const GATE_ACCEPTS: { label: string; content: string }[] = [
  { label: "plain", content: "---\nname: word-count\ndescription: Counts words.\n---\nBody" },
  { label: "quoted", content: `---\nname: "word-count"\ndescription: 'Counts words.'\n---\n` },
  {
    label: "commented",
    content: "---\nname: word-count # slug\ndescription: Counts words. # why\n---\n",
  },
  { label: "CRLF", content: "---\r\nname: word-count\r\ndescription: Counts words.\r\n---\r\n" },
  {
    label: "block-scalar description",
    content: "---\nname: word-count\ndescription: |\n  Counts words.\n---\n",
  },
  {
    label: "folded description",
    content: "---\nname: word-count\ndescription: >\n  Counts words.\n---\n",
  },
  {
    label: "next-line description",
    content: "---\nname: word-count\ndescription:\n  Counts words.\n---\n",
  },
  {
    label: "extra keys",
    content: "---\nlicense: MIT\nname: word-count\ndescription: Counts words.\n---\n",
  },
  { label: "64-char name", content: `---\nname: ${"a".repeat(64)}\ndescription: d\n---\n` },
  {
    label: "1024-code-point description",
    content: `---\nname: word-count\ndescription: ${"🙂".repeat(1024)}\n---\n`,
  },
];

describe("containment — the gate accepts a SUBSET of what the loader accepts", () => {
  for (const { label, content } of GATE_ACCEPTS) {
    it(`loader also accepts: ${label}`, () => {
      // Positive control first: this input really is one the gate accepts, so a
      // gate that silently started rejecting everything could not pass this.
      expect(checkSkill(content)).toBeNull();
      expect(checkArchive(content)).toBeNull();
    });
  }

  // The three forms that made this a blocker: valid YAML the loader's probe
  // cannot see. Accepted by the gate, they would mint an immutable version the
  // run launcher refuses to load.
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

// The whole point of the split: `checkCompanionFiles` runs on the LOADER side
// too (`extractRootFromAfps` → the run launcher's package catalog). Tightening
// it would fail every run of an agent whose published skill dependency predates
// the stricter rule — a defect nobody can fix in an immutable artifact.
describe("checkCompanionFiles — the LOADER side stays lenient", () => {
  it("accepts a published-style SKILL.md that declares only a name", () => {
    expect(checkArchive("---\nname: triage\n---\nbody")).toBeNull();
  });

  it("accepts names the producer rule refuses", () => {
    expect(checkArchive(skillMd("Legacy_Name", ""))).toBeNull();
    expect(checkArchive(skillMd("@acme/triage", ""))).toBeNull();
    expect(checkArchive(skillMd("a".repeat(200), ""))).toBeNull();
    expect(checkArchive(skillMd("triage", "d".repeat(5000)))).toBeNull();
  });

  // The substring probe is FROZEN, so these keep loading. Each was accepted
  // before the producer rule existed and could sit in a published, immutable
  // artifact today; the column-0 parser used by `checkSkillMarkdown` reads
  // none of them as a name.
  it("accepts frontmatter shapes that declare no top-level `name` at all", () => {
    for (const fm of [
      "---\nmetadata:\n  name: triage\n---\nbody",
      "---\nskill_name: triage\n---\nbody",
      "---\ndisplayname: Triage\n---\nbody",
    ]) {
      expect(checkArchive(fm)).toBeNull();
      // The substring probe sees `name:` anywhere; a YAML parser sees no
      // top-level `name` key. That gap is why the loader cannot be routed
      // through the parser — its acceptance set would shrink.
      expect(parseSkillFrontmatter(fm).name).toBe("");
    }
  });

  it("still requires SKILL.md to exist and to name something", () => {
    expect(checkArchive(null)).toBe("SKILL_MISSING_SKILL_MD");
    expect(checkArchive("# no frontmatter")).toBe("SKILL_MISSING_FRONTMATTER_NAME");
    expect(checkArchive("---\ndescription: no name\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_NAME",
    );
  });

  it("rejects, on the producer side, exactly what it accepted on the loader side", () => {
    expect(checkSkill("---\nname: triage\n---\nbody")).toBe(
      "SKILL_MISSING_FRONTMATTER_DESCRIPTION",
    );
    expect(checkSkill(skillMd("Legacy_Name", "d"))).toBe("SKILL_INVALID_FRONTMATTER_NAME");
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
