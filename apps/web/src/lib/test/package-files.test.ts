// SPDX-License-Identifier: Apache-2.0

/**
 * The per-type display-file table.
 *
 * `source` is not decoration: `pages/unified-package-detail.tsx` reads it to
 * pick the landing tab (`"content"` → open the artifact's files, `"manifest"`
 * → open the rendered manifest), and the diff tab reads
 * `companionDisplayFile` to decide whether the type has a second file to diff
 * at all. Both are structural facts about the AFPS types, so they are pinned
 * here rather than restated at either call site.
 */

import { describe, it, expect } from "bun:test";
import type { PackageType } from "@appstrate/core/validation";
import { companionDisplayFile, primaryDisplayFile } from "../package-files.ts";

const ALL_TYPES: PackageType[] = ["agent", "skill", "mcp-server", "integration"];

describe("primaryDisplayFile", () => {
  it("names the file each type's substance actually lives in", () => {
    expect(primaryDisplayFile("agent")).toEqual({ name: "prompt.md", source: "content" });
    expect(primaryDisplayFile("skill")).toEqual({ name: "SKILL.md", source: "content" });
    expect(primaryDisplayFile("integration")).toEqual({
      name: "INTEGRATION.md",
      source: "content",
    });
    // The one type with NO content file: its manifest is its only required
    // file (AFPS §3.4), which is why it lands on the rendered manifest.
    expect(primaryDisplayFile("mcp-server")).toEqual({
      name: "manifest.json",
      source: "manifest",
    });
  });

  it("is defined for every package type", () => {
    // A new AFPS type added without an entry would make the landing rule read
    // `undefined.source` at runtime, which tsc cannot catch through the
    // `Record<PackageType, …>` if the type union is widened elsewhere first.
    for (const type of ALL_TYPES) {
      expect(primaryDisplayFile(type).name).toMatch(/\S/);
      expect(["content", "manifest"]).toContain(primaryDisplayFile(type).source);
    }
  });
});

describe("companionDisplayFile", () => {
  it("is the content file for the types that have one, and absent for mcp-server", () => {
    expect(companionDisplayFile("agent")?.name).toBe("prompt.md");
    expect(companionDisplayFile("skill")?.name).toBe("SKILL.md");
    expect(companionDisplayFile("integration")?.name).toBe("INTEGRATION.md");
    expect(companionDisplayFile("mcp-server")).toBeUndefined();
  });

  it("agrees with the primary file wherever the primary is content-sourced", () => {
    for (const type of ALL_TYPES) {
      const primary = primaryDisplayFile(type);
      if (primary.source !== "content") continue;
      expect(companionDisplayFile(type)).toEqual(primary);
    }
  });
});
