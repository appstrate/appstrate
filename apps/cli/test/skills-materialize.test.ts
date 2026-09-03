// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of `appstrate skills sync`: ZIP entries → skill directory.
 * No network, no filesystem — the drop list, the name rewrite and the
 * determinism rule are assertable in isolation.
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
  it("keeps a frontmatter name that is already a legal Agent Skills name", () => {
    expect(skillSlug("pdf-tools", "something-else")).toBe("pdf-tools");
  });

  it("falls back to the package name segment when the frontmatter name is not legal", () => {
    expect(skillSlug("PDF Tools", "pdf-tools")).toBe("pdf-tools");
    expect(skillSlug("日本語", "reporting")).toBe("reporting");
  });

  it("slugifies the package name segment and trims edge hyphens", () => {
    expect(skillSlug("", "  Weekly -- Report!  ")).toBe("weekly-report");
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
    expect(normalizeSkillMd(CONFORMING_SKILL, "pdf-tools")).toBe(CONFORMING_SKILL);
  });

  it("rewrites only the name line when it differs from the slug", () => {
    const source = CONFORMING_SKILL.replace("name: pdf-tools", "name: PDF Tools");
    const out = normalizeSkillMd(source, "pdf-tools");
    expect(out).toBe(CONFORMING_SKILL);
    expect(out).toContain("allowed-tools: Read, Bash");
  });

  it("handles a name declared after other keys", () => {
    const source = "---\ndescription: Work with PDFs.\nname: PDF Tools\n---\n\nBody.\n";
    expect(normalizeSkillMd(source, "pdf-tools")).toBe(
      "---\ndescription: Work with PDFs.\nname: pdf-tools\n---\n\nBody.\n",
    );
  });

  it("prepends the name when the block only carries it inside a nested mapping", () => {
    const source = "---\nmeta:\n  name: inner\n  description: inner desc\n---\n\nBody.\n";
    expect(normalizeSkillMd(source, "pdf-tools")).toBe(
      "---\nname: pdf-tools\nmeta:\n  name: inner\n  description: inner desc\n---\n\nBody.\n",
    );
  });

  it("does not mistake an indented key inside a nested mapping for the top-level one", () => {
    const source = "---\nmeta:\n  name: inner\nname: PDF Tools\ndescription: Work.\n---\n\nBody.\n";
    expect(normalizeSkillMd(source, "pdf-tools")).toBe(
      "---\nmeta:\n  name: inner\nname: pdf-tools\ndescription: Work.\n---\n\nBody.\n",
    );
  });

  it("rewrites CRLF frontmatter in place and keeps CRLF line endings", () => {
    const source = "---\r\nname: PDF Tools\r\ndescription: Work.\r\n---\r\n\r\nBody.\r\n";
    const out = normalizeSkillMd(source, "pdf-tools");
    expect(out).toBe("---\r\nname: pdf-tools\r\ndescription: Work.\r\n---\r\n\r\nBody.\r\n");
    // The bug this pins prepended a SECOND key rather than replacing the first.
    expect(out.match(/^name:/gm)).toHaveLength(1);
  });

  it("leaves a file whose frontmatter yaml cannot parse otherwise untouched", () => {
    // Legacy published artifacts exist with an unquoted `description: a : b`.
    // The sync still points the name at the directory and copies the rest.
    const source = "---\nname: legacy\ndescription: Reports: weekly\n---\n\nBody.\n";
    expect(normalizeSkillMd(source, "legacy-skill")).toBe(
      "---\nname: legacy-skill\ndescription: Reports: weekly\n---\n\nBody.\n",
    );
  });

  it("leaves a file with no frontmatter block exactly as authored", () => {
    expect(normalizeSkillMd("Just a body.\n", "pdf-tools")).toBe("Just a body.\n");
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
    const out = materializeSkill({ slug: "pdf-tools", files });

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
    const first = materializeSkill({ slug: "pdf-tools", files });
    const second = materializeSkill({ slug: "pdf-tools", files });

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
    });
    expect(Object.keys(out)).toEqual(["SKILL.md", "a/b.txt", "z.txt"]);
  });

  it("copies a SKILL.md with no description exactly as authored", () => {
    // The sync does not invent a description: publishing without one is what
    // should be refused, upstream. Here it is copied, and the command reports it.
    const source = "---\nname: meeting-notes-fr\ndescription:\n---\n\nBody.\n";
    const out = materializeSkill({
      slug: "meeting-notes-fr",
      files: { "SKILL.md": encoder.encode(source) },
    });

    expect(decoder.decode(out["SKILL.md"]!)).toBe(source);
  });

  it("rejects a traversing entry", () => {
    expect(() =>
      materializeSkill({
        slug: "pdf-tools",
        files: {
          "SKILL.md": encoder.encode(CONFORMING_SKILL),
          "../../etc/passwd": encoder.encode("x"),
        },
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
      }),
    ).toThrow(/Refusing archive entry/);
  });

  it("rejects an artifact with no SKILL.md", () => {
    expect(() =>
      materializeSkill({ slug: "pdf-tools", files: { "notes.md": encoder.encode("hi") } }),
    ).toThrow(/no SKILL.md/);
  });
});
