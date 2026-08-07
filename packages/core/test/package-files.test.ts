// SPDX-License-Identifier: Apache-2.0

/**
 * The content-file table itself: every package type classified, exactly once.
 *
 * Whether a type's primary content file is MANDATORY used to be a
 * `type === "integration"` literal inside the file explorer's draft overlay
 * (`apps/api/src/services/package-files.ts`) — invisible from the map it was
 * qualifying, and covered only implicitly by that overlay's behaviour tests.
 * Now that it lives in the table, these cases are what replaces the branch's
 * implicit coverage: a new package type reaching the enum without a considered
 * classification, or a classification quietly flipping, fails here.
 *
 * TypeScript already forces an ENTRY per type (`Record<PackageType, …>`). What
 * it cannot check is the VALUE, which is the part each reader acts on.
 */

import { describe, expect, it } from "bun:test";
import { PACKAGE_CONTENT_ENTRY, PACKAGE_CONTENT_FILE } from "../src/package-files.ts";
import { packageTypeEnum, type PackageType } from "../src/validation.ts";

/**
 * The classification the platform runs on, restated independently of the
 * implementation. `null` = the type has no content file at all; its content IS
 * `manifest.json`. Change one, change the other — deliberately.
 */
const EXPECTED: Record<PackageType, { path: string; required: boolean } | null> = {
  agent: { path: "prompt.md", required: true },
  skill: { path: "SKILL.md", required: true },
  integration: { path: "INTEGRATION.md", required: false },
  "mcp-server": null,
};

describe("PACKAGE_CONTENT_ENTRY", () => {
  it("covers every package type, and nothing else", () => {
    expect(Object.keys(PACKAGE_CONTENT_ENTRY).sort()).toEqual([...packageTypeEnum.options].sort());
  });

  it("classifies each type: which file, and whether it is mandatory", () => {
    for (const type of packageTypeEnum.options) {
      expect(PACKAGE_CONTENT_ENTRY[type]).toEqual(EXPECTED[type]);
    }
  });

  it("marks exactly agent and skill as required", () => {
    // The distinction the draft overlay reads: a REQUIRED file is materialized
    // from `packages.draft_content` even with no stored ZIP, an OPTIONAL one
    // only on top of an entry that already exists — because when an
    // INTEGRATION.md is absent the import path puts the MANIFEST TEXT in that
    // column, and materializing it would invent a phantom companion.
    const required = packageTypeEnum.options
      .filter((type) => PACKAGE_CONTENT_ENTRY[type]?.required === true)
      .sort();
    expect(required).toEqual(["agent", "skill"]);
  });

  it("gives mcp-server no entry at all — its content is the manifest", () => {
    expect(PACKAGE_CONTENT_ENTRY["mcp-server"]).toBeNull();
  });

  it("declares no empty or nested path", () => {
    for (const type of packageTypeEnum.options) {
      const entry = PACKAGE_CONTENT_ENTRY[type];
      if (entry === null) continue;
      // Bundle-root entries: the ZIP extractor and the overlay both index the
      // flat file map by this exact string.
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.path).not.toContain("/");
    }
  });
});

describe("PACKAGE_CONTENT_FILE", () => {
  it("is the name-only projection of the table, not a second declaration", () => {
    for (const type of packageTypeEnum.options) {
      expect(PACKAGE_CONTENT_FILE[type]).toBe(PACKAGE_CONTENT_ENTRY[type]?.path ?? null);
    }
  });

  it("keeps the published string map byte-for-byte what consumers import", () => {
    // Exported from `@appstrate/core/package-files` since 6.2.0 and read by the
    // SPA (`apps/web/src/lib/package-files.ts`) and the ZIP extractor
    // (`packages/core/src/zip.ts`) as a plain `Record<PackageType, string | null>`.
    expect(PACKAGE_CONTENT_FILE).toEqual({
      agent: "prompt.md",
      skill: "SKILL.md",
      integration: "INTEGRATION.md",
      "mcp-server": null,
    });
  });
});
