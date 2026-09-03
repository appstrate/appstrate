// SPDX-License-Identifier: Apache-2.0

/**
 * PARITY: the platform's §3.3 gate vs the runtime that actually loads skills.
 *
 * `checkSkillMarkdown` (`@appstrate/afps-shared/companion-files`) decides which
 * `SKILL.md` the platform will mint into an IMMUTABLE version. Pi decides which
 * one an agent can actually use. When those two disagree in the accepting
 * direction, the platform freezes an artifact that silently never loads — and a
 * published version cannot be repaired. Three review rounds each found one more
 * instance of exactly that (a BOM, `name:` on the following line, `name:x`), so
 * the invariant gets a test that runs the REAL consumer instead of a
 * description of it.
 *
 * Pi is imported from its public entry: `parseFrontmatter` and
 * `loadSkillsFromDir` are both exported from `@earendil-works/pi-coding-agent`
 * (`dist/index.js`) — no deep path needed. `loadSkillsFromDir` is the one that
 * matters: it is the end-to-end verdict (`loadSkillFromFile` → `skill: null`
 * when the skill is dropped), and it takes a directory, so each fixture is
 * written to its own temp subdirectory.
 *
 * THE ASYMMETRY IS DELIBERATE, and the table states it per row:
 *
 *   - gate ACCEPTS ⇒ Pi must load the skill with the same `name` and
 *     `description`. No exceptions: this is the direction that mints unusable
 *     artifacts.
 *   - gate REJECTS ⇒ Pi either drops the skill, or loads it with a different
 *     name, or loads it while only WARNING. The last case is the platform
 *     being deliberately stricter than Pi, and it is safe: refusing to publish
 *     something Pi merely warns about costs an author one edit, where the
 *     reverse costs them an immutable artifact. Each such row says which.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";

/**
 * How Pi is expected to behave on a document the gate REFUSES.
 *
 * `"dropped"`      — Pi returns no skill at all (parse error, or no description).
 * `"warns-only"`   — Pi loads it; the platform is stricter on purpose. The
 *                    reason why is spelled per row.
 */
type PiOutcome = "dropped" | "warns-only";

interface Fixture {
  /** Directory name — deliberately NOT the expected skill name, because Pi
   *  falls back to the parent directory name when frontmatter has none. */
  dir: string;
  content: string;
  /** Expected `name` / `description` when the gate accepts. */
  name?: string;
  description?: string;
  /** For rejected rows: what Pi does, and why the platform is stricter. */
  pi?: PiOutcome;
  why?: string;
}

const LONG_EMOJI = "🙂".repeat(1024);
const NAME_64 = "a".repeat(64);

/** Documents the gate ACCEPTS. Pi must load every one of them identically. */
const ACCEPTED: Fixture[] = [
  {
    dir: "fx-plain",
    content: "---\nname: word-count\ndescription: Counts words in a text.\n---\nBody.",
    name: "word-count",
    description: "Counts words in a text.",
  },
  {
    dir: "fx-quoted",
    content: `---\nname: "word-count"\ndescription: 'Counts words.'\n---\nBody.`,
    name: "word-count",
    description: "Counts words.",
  },
  {
    dir: "fx-commented",
    content: "---\nname: word-count # the slug\ndescription: Counts words. # why\n---\nBody.",
    name: "word-count",
    description: "Counts words.",
  },
  {
    dir: "fx-crlf",
    content: "---\r\nname: word-count\r\ndescription: Counts words.\r\n---\r\nBody.",
    name: "word-count",
    description: "Counts words.",
  },
  {
    dir: "fx-block-scalar",
    content: "---\nname: word-count\ndescription: |\n  Counts words.\n  Use for stats.\n---\nBody.",
    name: "word-count",
    description: "Counts words.\nUse for stats.\n",
  },
  {
    dir: "fx-block-chomped",
    content: "---\nname: word-count\ndescription: |-\n  Counts words.\n---\nBody.",
    name: "word-count",
    description: "Counts words.",
  },
  {
    dir: "fx-folded",
    content: "---\nname: word-count\ndescription: >\n  Counts words\n  in a text.\n---\nBody.",
    name: "word-count",
    description: "Counts words in a text.\n",
  },
  {
    dir: "fx-next-line",
    content: "---\nname: word-count\ndescription:\n  Counts words in a text.\n---\nBody.",
    name: "word-count",
    description: "Counts words in a text.",
  },
  {
    dir: "fx-extra-keys",
    content:
      "---\nlicense: MIT\nname: word-count\ndescription: Counts words.\nversion: 1.0.0\n---\nBody.",
    name: "word-count",
    description: "Counts words.",
  },
  {
    dir: "fx-name-64",
    content: `---\nname: ${NAME_64}\ndescription: Counts words.\n---\nBody.`,
    name: NAME_64,
    description: "Counts words.",
  },
  {
    dir: "fx-desc-1024-codepoints",
    content: `---\nname: word-count\ndescription: "${LONG_EMOJI}"\n---\nBody.`,
    name: "word-count",
    description: LONG_EMOJI,
  },
  {
    dir: "fx-hash-in-quotes",
    content: `---\nname: word-count\ndescription: "Writes C# code # not a comment"\n---\nBody.`,
    name: "word-count",
    description: "Writes C# code # not a comment",
  },
  {
    dir: "fx-single-quote-escape",
    content: "---\nname: word-count\ndescription: 'It''s a counter.'\n---\nBody.",
    name: "word-count",
    description: "It's a counter.",
  },
  {
    dir: "fx-double-quote-escape",
    content: `---\nname: word-count\ndescription: "Use \\"grep\\" first."\n---\nBody.`,
    name: "word-count",
    description: 'Use "grep" first.',
  },
];

/** Documents the gate REFUSES, with Pi's own verdict on each. */
const REJECTED: Fixture[] = [
  {
    dir: "fx-bom",
    content: "﻿---\nname: word-count\ndescription: Counts words.\n---\nBody.",
    pi: "dropped",
    why: "Pi tests startsWith('---'); a BOM defeats it, so it reads no frontmatter and drops the skill",
  },
  {
    dir: "fx-no-space-after-colon",
    content: "---\nname:word-count\ndescription: Counts words.\n---\nBody.",
    pi: "dropped",
    why: "YAML: implicit keys need to be on a single line — parseFrontmatter throws",
  },
  {
    dir: "fx-colon-in-value",
    content: "---\nname: word-count\ndescription: a: b\n---\nBody.",
    pi: "dropped",
    why: "YAML: nested mappings are not allowed in compact mappings — parseFrontmatter throws",
  },
  {
    dir: "fx-duplicate-key",
    content: "---\nname: word-count\ndescription: a\ndescription: b\n---\nBody.",
    pi: "dropped",
    why: "YAML: map keys must be unique — parseFrontmatter throws",
  },
  {
    dir: "fx-missing-description",
    content: "---\nname: word-count\n---\nBody.",
    pi: "dropped",
    why: "Pi returns skill: null when description is missing or blank",
  },
  {
    dir: "fx-not-a-mapping",
    content: "---\n- a\n- b\n---\nBody.",
    pi: "dropped",
    why: "a sequence has no description, so Pi drops it",
  },
  {
    dir: "fx-uppercase-name",
    content: "---\nName-Is: x\nname: Word_Count\ndescription: Counts words.\n---\nBody.",
    pi: "warns-only",
    why: "Pi WARNS on a name that breaks the Agent Skills rule but still loads it; the platform refuses to mint it, because the spec says MUST and a version is immutable",
  },
  {
    dir: "fx-name-65",
    content: `---\nname: ${"a".repeat(65)}\ndescription: Counts words.\n---\nBody.`,
    pi: "warns-only",
    why: "same: Pi warns above 64 characters, the platform refuses",
  },
  {
    dir: "fx-name-next-line",
    content: "---\nname:\n  word-count\ndescription: Counts words.\n---\nBody.",
    pi: "warns-only",
    why: "valid YAML that Pi reads fine, but the PLATFORM's own package loader (a frozen substring probe over published artifacts) cannot see it — so the platform refuses to write it",
  },
];

let root: string;
/** Skill loaded by Pi, keyed by fixture directory name. */
let loaded: Map<string, { name: string; description: string }>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "skill-parity-"));
  for (const fx of [...ACCEPTED, ...REJECTED]) {
    const dir = join(root, fx.dir);
    mkdirSync(dir, { recursive: true });
    // Written as raw bytes so a BOM survives — `writeFileSync` with a string
    // and utf-8 would encode U+FEFF faithfully, which is what we want here.
    writeFileSync(join(dir, "SKILL.md"), fx.content, "utf-8");
  }
  const result = loadSkillsFromDir({ dir: root, source: "path" });
  loaded = new Map(
    result.skills.map((s) => [
      s.filePath.slice(root.length + 1).split("/")[0]!,
      { name: s.name, description: s.description },
    ]),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("SKILL.md parity — gate accepts ⇒ Pi loads it identically", () => {
  for (const fx of ACCEPTED) {
    it(`${fx.dir}`, () => {
      // Positive control: this row really is one the gate accepts, so the
      // suite cannot pass by the gate silently rejecting everything.
      expect(checkSkillMarkdown(fx.content)).toBeNull();

      const skill = loaded.get(fx.dir);
      expect(skill, `Pi dropped a skill the gate accepted: ${fx.dir}`).toBeDefined();
      expect(skill!.name).toBe(fx.name!);
      expect(skill!.description).toBe(fx.description!);

      // And the two parsers agree field for field, not just "it loaded".
      const pi = parseFrontmatter(fx.content).frontmatter as Record<string, unknown>;
      expect(pi.name).toBe(fx.name!);
      expect(pi.description).toBe(fx.description!);
    });
  }
});

describe("SKILL.md parity — gate rejects ⇒ Pi drops it, or the platform is stricter on purpose", () => {
  for (const fx of REJECTED) {
    it(`${fx.dir} — ${fx.why}`, () => {
      expect(checkSkillMarkdown(fx.content)).not.toBeNull();

      const skill = loaded.get(fx.dir);
      if (fx.pi === "dropped") {
        expect(
          skill,
          `Pi loaded a skill the gate rejected as unloadable: ${fx.dir}`,
        ).toBeUndefined();
      } else {
        // The documented exception: Pi loads it, the platform refuses. Assert
        // it really is loadable, so a row cannot quietly drift into the
        // dangerous direction without the label changing.
        expect(skill, `expected Pi to still load ${fx.dir}`).toBeDefined();
      }
    });
  }
});

describe("SKILL.md parity — the asymmetry is one-directional", () => {
  it("never accepts a document Pi cannot load", () => {
    const acceptedButUnloadable = ACCEPTED.filter((fx) => !loaded.has(fx.dir)).map((fx) => fx.dir);
    expect(acceptedButUnloadable).toEqual([]);
  });

  it("every rejected row is labelled with Pi's actual verdict", () => {
    for (const fx of REJECTED) {
      expect(fx.pi === "dropped" ? !loaded.has(fx.dir) : loaded.has(fx.dir)).toBe(true);
    }
  });
});
