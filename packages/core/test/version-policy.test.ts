// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  shouldUpdateLatestTag,
  planCreateVersionOutcome,
  planTagReassignment,
} from "../src/version-policy.ts";

describe("shouldUpdateLatestTag", () => {
  it("returns true for first stable version (no current latest)", () => {
    expect(shouldUpdateLatestTag("1.0.0", null)).toBe(true);
  });

  it("returns true when new version is higher than current", () => {
    expect(shouldUpdateLatestTag("2.0.0", "1.0.0")).toBe(true);
  });

  it("returns true when new version equals current (replacement)", () => {
    expect(shouldUpdateLatestTag("1.0.0", "1.0.0")).toBe(true);
  });

  it("returns false for prerelease version", () => {
    expect(shouldUpdateLatestTag("2.0.0-beta.1", null)).toBe(false);
    expect(shouldUpdateLatestTag("2.0.0-beta.1", "1.0.0")).toBe(false);
  });

  it("returns false when current latest is higher", () => {
    expect(shouldUpdateLatestTag("1.0.0", "2.0.0")).toBe(false);
  });
});

describe("planCreateVersionOutcome", () => {
  it("first version → insert + shouldUpdateLatest", () => {
    expect(planCreateVersionOutcome("1.0.0", [], null)).toEqual({
      action: "insert",
      shouldUpdateLatest: true,
    });
  });

  it("higher version → insert + shouldUpdateLatest", () => {
    expect(planCreateVersionOutcome("2.0.0", ["1.0.0"], "1.0.0")).toEqual({
      action: "insert",
      shouldUpdateLatest: true,
    });
  });

  it("duplicate version → exists", () => {
    expect(planCreateVersionOutcome("1.0.0", ["1.0.0"], "1.0.0")).toEqual({
      action: "exists",
    });
  });

  it("lower version → rejected", () => {
    expect(planCreateVersionOutcome("1.0.0", ["2.0.0"], "2.0.0")).toEqual({
      action: "rejected",
      error: "VERSION_NOT_HIGHER",
      highest: "2.0.0",
    });
  });

  it("prerelease does not update latest", () => {
    expect(planCreateVersionOutcome("2.0.0-beta.1", ["1.0.0"], "1.0.0")).toEqual({
      action: "insert",
      shouldUpdateLatest: false,
    });
  });

  it("invalid semver → rejected with VERSION_INVALID", () => {
    expect(planCreateVersionOutcome("not-semver", ["1.0.0"], "1.0.0")).toEqual({
      action: "rejected",
      error: "VERSION_INVALID",
    });
  });

  it("stable higher than prerelease latest → shouldUpdateLatest", () => {
    expect(planCreateVersionOutcome("2.0.0", ["1.0.0-beta.1"], null)).toEqual({
      action: "insert",
      shouldUpdateLatest: true,
    });
  });
});

describe("planTagReassignment", () => {
  it("no affected tags → empty array", () => {
    expect(planTagReassignment([], [{ id: 1, version: "1.0.0" }])).toEqual([]);
  });

  it("1 tag with stable candidate → reassign", () => {
    expect(planTagReassignment([{ tag: "latest" }], [{ id: 2, version: "1.0.0" }])).toEqual([
      { tag: "latest", action: "reassign", newVersionId: 2 },
    ]);
  });

  it("1 tag with no candidates → delete", () => {
    expect(planTagReassignment([{ tag: "latest" }], [])).toEqual([
      { tag: "latest", action: "delete" },
    ]);
  });

  it("multiple tags → all reassigned to same best", () => {
    const result = planTagReassignment(
      [{ tag: "latest" }, { tag: "stable" }],
      [
        { id: 1, version: "1.0.0" },
        { id: 3, version: "2.0.0" },
      ],
    );
    expect(result).toEqual([
      { tag: "latest", action: "reassign", newVersionId: 3 },
      { tag: "stable", action: "reassign", newVersionId: 3 },
    ]);
  });

  it("only prerelease candidates → all tags deleted", () => {
    const result = planTagReassignment([{ tag: "latest" }], [{ id: 1, version: "1.0.0-alpha.1" }]);
    expect(result).toEqual([{ tag: "latest", action: "delete" }]);
  });
});
