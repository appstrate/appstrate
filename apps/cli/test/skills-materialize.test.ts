// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of `appstrate skills sync`: ZIP entries → skill directory.
 *
 * Everything here runs without a network or a filesystem, which is the point
 * of splitting `lib/skills-sync/materialize.ts` out — the three rules that
 * decide what Claude Code and Codex actually load (determinism, the drop list,
 * the frontmatter rewrite) are assertable in isolation.
 */

import { describe, it, expect } from "bun:test";
import {
  PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
  stripWrapperPrefix,
  unzipArtifact,
  zipArtifact,
} from "@appstrate/core/zip";
import {
  SkillMaterializeError,
  collisionSlug,
  materializeSkill,
  normalizeSkillMd,
  skillSlug,
} from "../src/lib/skills-sync/materialize.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function skillManifest(name: string, description: string): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      afps_version: "0.2",
      type: "skill",
      name,
      version: "1.0.0",
      description,
    }),
  );
}

/**
 * Build a real `.afps` archive and unpack it the way the sync does, so the
 * fixtures exercise `zipArtifact` + `unzipArtifact` + `stripWrapperPrefix`
 * under the same decompression ceiling rather than a hand-written map that
 * could drift from what the platform actually stores.
 */
function artifactFiles(entries: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const zippable: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(entries)) {
    zippable[path] = typeof value === "string" ? encoder.encode(value) : value;
  }
  return stripWrapperPrefix(
    unzipArtifact(zipArtifact(zippable), {
      maxDecompressedBytes: PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
    }),
  );
}

const CONFORMING_SKILL = `---
name: pdf-tools
description: Work with PDFs.
allowed-tools: Read, Bash
---

# PDF tools

Body text.
`;

describe("skillSlug", () => {
  it("derives the slug from the frontmatter name", () => {
    expect(skillSlug("PDF Tools", "pdf-tools")).toBe("pdf-tools");
  });

  it("falls back to the package name segment when the frontmatter name slugifies to nothing", () => {
    expect(skillSlug("日本語", "reporting")).toBe("reporting");
  });

  it("collapses punctuation runs and trims edge hyphens", () => {
    expect(skillSlug("  Weekly -- Report!  ", "x")).toBe("weekly-report");
  });

  it("refuses a name that cannot become a legal Agent Skills name", () => {
    expect(() => skillSlug("", "")).toThrow(SkillMaterializeError);
  });
});

describe("collisionSlug", () => {
  it("renders the package id as <scope>-<name>", () => {
    expect(collisionSlug("@acme/pdf-tools", new Set())).toBe("acme-pdf-tools");
  });

  it("appends a counter when the <scope>-<name> form is itself taken", () => {
    const taken = new Set(["acme-foo", "acme-foo-2"]);
    expect(collisionSlug("@acme/foo", taken)).toBe("acme-foo-3");
  });

  it("keeps the counter inside the 64-character ceiling by trimming the base", () => {
    const long = `@${"a".repeat(40)}/${"b".repeat(40)}`;
    const first = collisionSlug(long, new Set());
    expect(first.length).toBe(64);
    const second = collisionSlug(long, new Set([first]));
    expect(second.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
    expect(second.endsWith("-2")).toBe(true);
  });
});

describe("normalizeSkillMd", () => {
  it("leaves a conforming file byte-for-byte alone", () => {
    expect(normalizeSkillMd(CONFORMING_SKILL, "pdf-tools", "from manifest")).toBe(CONFORMING_SKILL);
  });

  it("rewrites only the name line when it differs from the slug", () => {
    const source = CONFORMING_SKILL.replace("name: pdf-tools", "name: PDF Tools");
    const out = normalizeSkillMd(source, "pdf-tools", "from manifest");
    expect(out).toBe(CONFORMING_SKILL);
    expect(out).toContain("allowed-tools: Read, Bash");
  });

  it("injects the manifest description when the frontmatter has none", () => {
    const source = `---\nname: pdf-tools\n---\n\nBody.\n`;
    const out = normalizeSkillMd(source, "pdf-tools", "Work with PDFs.");
    expect(out).toBe(`---\nname: pdf-tools\ndescription: "Work with PDFs."\n---\n\nBody.\n`);
  });

  it("quotes an injected description so a colon or a bracket cannot break the YAML", () => {
    const source = `---\nname: pdf-tools\n---\nBody.\n`;
    const out = normalizeSkillMd(source, "pdf-tools", 'Reports: [draft] with "quotes"');
    expect(out).toContain('description: "Reports: [draft] with \\"quotes\\""');
  });

  it("does not overwrite a description the skill already declares", () => {
    const out = normalizeSkillMd(CONFORMING_SKILL, "pdf-tools", "SOMETHING ELSE");
    expect(out).toContain("description: Work with PDFs.");
    expect(out).not.toContain("SOMETHING ELSE");
  });

  it("replaces a multi-line name value together with its continuation lines", () => {
    const source = `---\nname:\n  Long\n  Name\ndescription: Work with PDFs.\n---\n\nBody.\n`;
    const out = normalizeSkillMd(source, "pdf-tools", "from manifest");
    expect(out).toBe(`---\nname: pdf-tools\ndescription: Work with PDFs.\n---\n\nBody.\n`);
  });

  it("treats a multi-line description as present and leaves it untouched", () => {
    const source = `---\nname: pdf-tools\ndescription:\n  line one\n  line two\n---\n\nBody.\n`;
    const out = normalizeSkillMd(source, "pdf-tools", "SHOULD NOT APPEAR");
    expect(out).toBe(source);
    expect(out).not.toContain("SHOULD NOT APPEAR");
  });

  it("keeps a literal block scalar intact while rewriting the name above it", () => {
    const source = `---\nname: PDF Tools\ndescription: |\n  first\n\n  second\nallowed-tools: Read\n---\n\nBody.\n`;
    const out = normalizeSkillMd(source, "pdf-tools", "ignored");
    expect(out).toBe(
      `---\nname: pdf-tools\ndescription: |\n  first\n\n  second\nallowed-tools: Read\n---\n\nBody.\n`,
    );
  });

  it("does not duplicate a bare name key that carries a block value", () => {
    const source = `---\ndescription: Work with PDFs.\nname:\n  pdf tools\n---\n\nBody.\n`;
    const out = normalizeSkillMd(source, "pdf-tools", "ignored");
    expect(out.match(/^name:/gm)).toHaveLength(1);
    expect(out).toContain("name: pdf-tools");
    expect(out).not.toContain("  pdf tools");
  });

  it("rewrites CRLF frontmatter in place and keeps CRLF line endings", () => {
    const source = "---\r\nname: PDF Tools\r\ndescription: Work.\r\n---\r\n\r\nBody.\r\n";
    const out = normalizeSkillMd(source, "pdf-tools", "from manifest");
    expect(out).toBe("---\r\nname: pdf-tools\r\ndescription: Work.\r\n---\r\n\r\nBody.\r\n");
    // The bug this pins prepended a SECOND key rather than replacing the first.
    expect(out.match(/^name:/gm)).toHaveLength(1);
  });

  it("fills an empty description value without losing the injected name", () => {
    const out = normalizeSkillMd("---\ndescription:\n---\n\nBody.\n", "pdf-tools", "From manifest");
    expect(out).toBe('---\nname: pdf-tools\ndescription: "From manifest"\n---\n\nBody.\n');
    expect(out.match(/^description:/gm)).toHaveLength(1);
  });

  it("handles description declared before name", () => {
    const source = "---\ndescription: Work with PDFs.\nname: PDF Tools\n---\n\nBody.\n";
    const out = normalizeSkillMd(source, "pdf-tools", "ignored");
    expect(out).toBe("---\ndescription: Work with PDFs.\nname: pdf-tools\n---\n\nBody.\n");
  });

  it("does not mistake an indented key inside a nested mapping for the top-level one", () => {
    const source =
      "---\nmeta:\n  name: inner\n  description: inner desc\nname: PDF Tools\n---\n\nBody.\n";
    const out = normalizeSkillMd(source, "pdf-tools", "From manifest");
    expect(out).toBe(
      '---\nmeta:\n  name: inner\n  description: inner desc\nname: pdf-tools\ndescription: "From manifest"\n---\n\nBody.\n',
    );
  });

  it("sees through a UTF-8 BOM instead of prepending a second frontmatter", () => {
    const out = normalizeSkillMd(`\uFEFF${CONFORMING_SKILL}`, "pdf-tools", "ignored");
    expect(out).toBe(CONFORMING_SKILL);
    expect(out.match(/^---$/gm)).toHaveLength(2);
    expect(out.startsWith("\uFEFF")).toBe(false);
  });

  it("adds a frontmatter block to a file that has none", () => {
    const out = normalizeSkillMd("Just a body.\n", "pdf-tools", "Work with PDFs.");
    expect(out).toBe(`---\nname: pdf-tools\ndescription: "Work with PDFs."\n---\n\nJust a body.\n`);
  });
});

describe("materializeSkill", () => {
  it("drops manifest.json and RECORD and keeps everything else verbatim", () => {
    const files = artifactFiles({
      "manifest.json": skillManifest("@acme/pdf-tools", "Work with PDFs."),
      RECORD: "SKILL.md,sha256-xxx\n",
      "SKILL.md": CONFORMING_SKILL,
      "reference/table.csv": "a,b\n1,2\n",
    });
    const out = materializeSkill({ slug: "pdf-tools", files, manifestDescription: "unused" });

    expect(Object.keys(out).sort()).toEqual(["SKILL.md", "reference/table.csv"]);
    expect(decoder.decode(out["reference/table.csv"]!)).toBe("a,b\n1,2\n");
    expect(decoder.decode(out["SKILL.md"]!)).toBe(CONFORMING_SKILL);
  });

  it("produces identical bytes across two runs over the same artifact", () => {
    const files = artifactFiles({
      "manifest.json": skillManifest("@acme/pdf-tools", "Work with PDFs."),
      "SKILL.md": CONFORMING_SKILL.replace("name: pdf-tools", "name: PDF Tools"),
      "assets/logo.bin": new Uint8Array([1, 2, 3, 4]),
    });
    const first = materializeSkill({ slug: "pdf-tools", files, manifestDescription: "d" });
    const second = materializeSkill({ slug: "pdf-tools", files, manifestDescription: "d" });

    expect(Object.keys(first)).toEqual(Object.keys(second));
    for (const path of Object.keys(first)) {
      expect(Array.from(second[path]!)).toEqual(Array.from(first[path]!));
    }
  });

  it("keys entries in sorted order so writers hash a stable sequence", () => {
    const out = materializeSkill({
      slug: "pdf-tools",
      files: {
        "z.txt": encoder.encode("z"),
        "SKILL.md": encoder.encode(CONFORMING_SKILL),
        "a/b.txt": encoder.encode("b"),
      },
      manifestDescription: "d",
    });
    expect(Object.keys(out)).toEqual(["SKILL.md", "a/b.txt", "z.txt"]);
  });

  it("rejects a traversing entry", () => {
    expect(() =>
      materializeSkill({
        slug: "pdf-tools",
        files: {
          "SKILL.md": encoder.encode(CONFORMING_SKILL),
          "../../etc/passwd": encoder.encode("x"),
        },
        manifestDescription: "d",
      }),
    ).toThrow(/Refusing archive entry/);
  });

  it("rejects an absolute entry", () => {
    expect(() =>
      materializeSkill({
        slug: "pdf-tools",
        files: {
          "SKILL.md": encoder.encode(CONFORMING_SKILL),
          "/etc/passwd": encoder.encode("x"),
        },
        manifestDescription: "d",
      }),
    ).toThrow(/Refusing archive entry/);
  });

  it("rejects a directory-only entry", () => {
    expect(() =>
      materializeSkill({
        slug: "pdf-tools",
        files: {
          "SKILL.md": encoder.encode(CONFORMING_SKILL),
          "nested/": new Uint8Array(),
        },
        manifestDescription: "d",
      }),
    ).toThrow(/Refusing archive entry/);
  });

  it("rejects an artifact with no SKILL.md", () => {
    expect(() =>
      materializeSkill({
        slug: "pdf-tools",
        files: { "notes.md": encoder.encode("hi") },
        manifestDescription: "d",
      }),
    ).toThrow(/no SKILL.md/);
  });
});
