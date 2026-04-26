// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  isValidVersion,
  compareVersionsDesc,
  matchVersion,
  resolveVersionFromCatalog,
} from "../src/semver.ts";

describe("isValidVersion", () => {
  it('"1.0.0" is valid', () => {
    expect(isValidVersion("1.0.0")).toBe(true);
  });

  it('"0.0.1" is valid', () => {
    expect(isValidVersion("0.0.1")).toBe(true);
  });

  it('"1.2.3-beta.1" is valid (prerelease)', () => {
    expect(isValidVersion("1.2.3-beta.1")).toBe(true);
  });

  it('"1.0.0+build.123" is valid (build metadata)', () => {
    expect(isValidVersion("1.0.0+build.123")).toBe(true);
  });

  it('"1.0" is invalid (missing patch)', () => {
    expect(isValidVersion("1.0")).toBe(false);
  });

  it('"abc" is invalid', () => {
    expect(isValidVersion("abc")).toBe(false);
  });

  it('"1.2.3.4" is invalid (too many segments)', () => {
    expect(isValidVersion("1.2.3.4")).toBe(false);
  });

  it('"" is invalid (empty string)', () => {
    expect(isValidVersion("")).toBe(false);
  });
});

describe("compareVersionsDesc", () => {
  it("sorts versions in descending order", () => {
    const sorted = ["1.0.0", "2.0.0", "1.5.0"].sort(compareVersionsDesc);
    expect(sorted).toEqual(["2.0.0", "1.5.0", "1.0.0"]);
  });

  it("handles prerelease ordering", () => {
    const sorted = ["1.0.0", "1.0.0-beta.1", "1.0.0-alpha.1"].sort(compareVersionsDesc);
    expect(sorted).toEqual(["1.0.0", "1.0.0-beta.1", "1.0.0-alpha.1"]);
  });
});

describe("matchVersion", () => {
  it("^1.0.0 matches highest compatible", () => {
    expect(matchVersion(["1.0.0", "1.1.0", "2.0.0"], "^1.0.0")).toBe("1.1.0");
  });

  it("~1.0.0 matches highest patch", () => {
    expect(matchVersion(["1.0.0", "1.0.5", "1.1.0"], "~1.0.0")).toBe("1.0.5");
  });

  it("returns null when no match", () => {
    expect(matchVersion(["1.0.0", "1.1.0"], "^2.0.0")).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(matchVersion([], "^1.0.0")).toBeNull();
  });
});

describe("resolveVersionFromCatalog", () => {
  const versions = [
    { id: 1, version: "1.0.0", yanked: false },
    { id: 2, version: "1.1.0", yanked: false },
    { id: 3, version: "2.0.0", yanked: false },
    { id: 4, version: "2.0.1", yanked: true },
    { id: 5, version: "3.0.0-beta.1", yanked: false },
  ];

  const distTags = [
    { tag: "latest", versionId: 3 },
    { tag: "beta", versionId: 5 },
  ];

  // --- Exact match ---
  it("exact match returns version id", () => {
    expect(resolveVersionFromCatalog("1.0.0", versions, distTags)).toBe(1);
  });

  it("exact match on yanked version still resolves (like npm)", () => {
    expect(resolveVersionFromCatalog("2.0.1", versions, distTags)).toBe(4);
  });

  it("exact match for non-existent version returns null", () => {
    expect(resolveVersionFromCatalog("9.9.9", versions, distTags)).toBeNull();
  });

  // --- Dist-tag ---
  it("dist-tag 'latest' resolves to tagged version", () => {
    expect(resolveVersionFromCatalog("latest", versions, distTags)).toBe(3);
  });

  it("dist-tag 'beta' resolves to tagged version", () => {
    expect(resolveVersionFromCatalog("beta", versions, distTags)).toBe(5);
  });

  it("unknown dist-tag falls through to range (which also fails)", () => {
    expect(resolveVersionFromCatalog("nightly", versions, distTags)).toBeNull();
  });

  it("dist-tag pointing to yanked version returns null (excludes yanked)", () => {
    const yankedDistTags = [{ tag: "old", versionId: 4 }];
    expect(resolveVersionFromCatalog("old", versions, yankedDistTags)).toBeNull();
  });

  // --- Semver range ---
  it("^1.0.0 resolves to highest compatible non-yanked", () => {
    expect(resolveVersionFromCatalog("^1.0.0", versions, distTags)).toBe(2); // 1.1.0
  });

  it("^2.0.0 resolves to 2.0.0 (2.0.1 is yanked)", () => {
    expect(resolveVersionFromCatalog("^2.0.0", versions, distTags)).toBe(3); // 2.0.0
  });

  it(">=3.0.0 matches prerelease if it's the only candidate", () => {
    // semver.maxSatisfying with includePrerelease is not default,
    // so >=3.0.0 won't match 3.0.0-beta.1 unless explicitly included
    // This is standard semver behavior
    expect(resolveVersionFromCatalog(">=3.0.0", versions, distTags)).toBeNull();
  });

  it("~1.0.0 resolves to 1.0.0 (no 1.0.x patches)", () => {
    expect(resolveVersionFromCatalog("~1.0.0", versions, distTags)).toBe(1);
  });

  it("^5.0.0 returns null (no matching versions)", () => {
    expect(resolveVersionFromCatalog("^5.0.0", versions, distTags)).toBeNull();
  });

  // --- Fallback ---
  it("completely invalid query returns null", () => {
    expect(resolveVersionFromCatalog("not-a-thing", versions, distTags)).toBeNull();
  });

  it("empty versions list returns null for any query", () => {
    expect(resolveVersionFromCatalog("1.0.0", [], [])).toBeNull();
    expect(resolveVersionFromCatalog("latest", [], [])).toBeNull();
    expect(resolveVersionFromCatalog("^1.0.0", [], [])).toBeNull();
  });
});
